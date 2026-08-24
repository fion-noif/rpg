// Integration tests for manager adjustments, against a real Postgres database. Same
// skip-if-unreachable contract as src/usage.db.test.ts: with no test database every case
// here skips rather than fails, so `npm test` still passes on a fresh clone.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db';
import { setUsageQty, usageForCustomer } from './usage';
import { adminAddLine, adminSetQty, adminVoidLine, adminWorkerFor } from './admin-review';
import { applySchema, resetSchema, seedFixtures, type Fixtures } from './test-helpers';

let dbAvailable = true;
let fx: Fixtures;

before(async () => {
  try {
    await pool.query('SELECT 1');
    await applySchema(pool);
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `\nSkipping src/admin-review.db.test.ts — no reachable test database (${(err as Error).message}).\n` +
        'Run `npm run db:up`, then `docker compose exec db psql -U racing -c "CREATE DATABASE racing_test"`.\n'
    );
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await resetSchema(pool);
  fx = await seedFixtures(pool);
});

after(async () => {
  await pool.end();
});

async function workerLine(qty: number): Promise<void> {
  const r = await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty,
  });
  assert.equal(r.ok, true);
}

async function actions(): Promise<{ action: string; detail: any }[]> {
  const { rows } = await pool.query(`SELECT action, detail FROM admin_actions ORDER BY id`);
  return rows;
}

async function approve(): Promise<void> {
  await pool.query(
    `INSERT INTO charge_batches (event_id, customer_qbo_id, doc_number) VALUES ($1, $2, 'RW-T1-1')`,
    [fx.eventId, fx.customerId]
  );
}

test('adminWorkerFor is idempotent: one Manager staff row, one admin worker per event', async (t) => {
  if (!dbAvailable) return t.skip();
  const a = await adminWorkerFor(pool, fx.eventId);
  const b = await adminWorkerFor(pool, fx.eventId);
  assert.equal(a, b);

  // A second event reuses the same person, with its own participation row.
  const {
    rows: [other],
  } = await pool.query<{ id: number }>(`INSERT INTO events (code, name) VALUES ('T2', 'Other') RETURNING id`);
  const c = await adminWorkerFor(pool, other.id);
  assert.notEqual(c, a);

  const { rows: staff } = await pool.query(`SELECT id FROM staff WHERE name = 'Manager'`);
  assert.equal(staff.length, 1);
  const { rows: admins } = await pool.query(`SELECT event_id, token_hash FROM workers WHERE is_admin`);
  assert.equal(admins.length, 2);
  // The manager is never reachable by a magic link (src/workers.ts hashes a token).
  assert.deepEqual(
    admins.map((r) => r.token_hash),
    [null, null]
  );
});

test('an edit voids the worker line and puts the corrected qty on the manager tab', async (t) => {
  if (!dbAvailable) return t.skip();
  await workerLine(3);

  const result = await adminSetQty({
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty: 5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.line?.qty, 5);

  const live = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(live.length, 1);
  assert.equal(live[0].qty, 5);
  assert.equal(live[0].isAdmin, true);
  assert.equal(live[0].unitPrice, 9.5); // the original snapshot is carried over, not re-priced

  // The worker's row is still there, voided and attributed to the manager (design doc §31).
  const adminWorkerId = await adminWorkerFor(pool, fx.eventId);
  const { rows } = await pool.query(
    `SELECT l.qty::float AS qty, l.voided_at, l.voided_by, s.worker_id
     FROM submission_lines l JOIN submissions s ON s.id = l.submission_id
     WHERE l.voided_at IS NOT NULL`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 3);
  assert.equal(rows[0].worker_id, fx.workerAId);
  assert.equal(rows[0].voided_by, adminWorkerId);
  assert.notEqual(rows[0].voided_at, null);

  const log = await actions();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'edit-qty');
  assert.equal(log[0].detail.before, 3);
  assert.equal(log[0].detail.after, 5);
  assert.equal(log[0].detail.itemId, fx.itemId);
  assert.equal(log[0].detail.voided[0].workerId, fx.workerAId);
});

test('editing again adjusts the manager line in place of a second void', async (t) => {
  if (!dbAvailable) return t.skip();
  await workerLine(3);
  await adminSetQty({ eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 5 });
  await adminSetQty({ eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 6 });

  const live = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(live.length, 1);
  assert.equal(live[0].qty, 6);

  // One voided worker row, one live manager row — the second edit did not void anything.
  const { rows } = await pool.query('SELECT count(*) FROM submission_lines');
  assert.equal(rows[0].count, '2');
  const log = await actions();
  assert.equal(log.length, 2);
  assert.equal(log[1].detail.before, 5);
  assert.equal(log[1].detail.after, 6);
});

test('an edit collapses two workers who recorded the same part onto one manager line', async (t) => {
  if (!dbAvailable) return t.skip();
  await workerLine(3);
  await setUsageQty({
    workerId: fx.workerBId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty: 4,
  });

  await adminSetQty({ eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 6 });

  const live = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(live.length, 1);
  assert.equal(live[0].qty, 6);
  const log = await actions();
  assert.equal(log[0].detail.before, 7); // 3 + 4, so the log explains where 6 came from
  assert.equal(log[0].detail.voided.length, 2);
});

test('adding a part creates a manager line; an inactive part is refused', async (t) => {
  if (!dbAvailable) return t.skip();
  const result = await adminAddLine({
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty: 2,
  });
  assert.equal(result.ok, true);

  const live = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(live.length, 1);
  assert.equal(live[0].qty, 2);
  assert.equal(live[0].isAdmin, true);

  const inactive = await adminAddLine({
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.inactiveItemId,
    qty: 1,
  });
  assert.deepEqual(inactive, { ok: false, reason: 'unknown-item' });

  const unknown = await adminAddLine({
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: 'nope',
    qty: 1,
  });
  assert.deepEqual(unknown, { ok: false, reason: 'unknown-item' });

  const log = await actions();
  assert.equal(log.length, 1); // the two refusals rolled back, including their audit rows
  assert.equal(log[0].action, 'add-line');
  assert.equal(log[0].detail.before, 0);
  assert.equal(log[0].detail.after, 2);
});

test('a void removes the line from the live view but preserves the row', async (t) => {
  if (!dbAvailable) return t.skip();
  await workerLine(3);
  const [line] = await usageForCustomer(fx.eventId, fx.customerId);

  const result = await adminVoidLine({ eventId: fx.eventId, customerId: fx.customerId, lineId: line.id });
  assert.deepEqual(result, { ok: true, line: null });

  assert.equal((await usageForCustomer(fx.eventId, fx.customerId)).length, 0);

  const adminWorkerId = await adminWorkerFor(pool, fx.eventId);
  const { rows } = await pool.query('SELECT qty::float AS qty, voided_by FROM submission_lines');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 3);
  assert.equal(rows[0].voided_by, adminWorkerId);

  const log = await actions();
  assert.equal(log[0].action, 'void-line');
  assert.equal(log[0].detail.before, 3);
  assert.equal(log[0].detail.after, 0);
  assert.equal(log[0].detail.voided[0].workerId, fx.workerAId);

  // Voiding the same line twice is a no-op refusal, not a second audit entry.
  const again = await adminVoidLine({ eventId: fx.eventId, customerId: fx.customerId, lineId: line.id });
  assert.deepEqual(again, { ok: false, reason: 'unknown-line' });
  assert.equal((await actions()).length, 1);
});

test('a line belonging to another event or customer is not reachable', async (t) => {
  if (!dbAvailable) return t.skip();
  await workerLine(3);
  const [line] = await usageForCustomer(fx.eventId, fx.customerId);

  await pool.query(
    `INSERT INTO customers (qbo_id, display_name, active, sync_token, raw, synced_at)
     VALUES ('cust-2', 'Other Customer', true, '0', '{}'::jsonb, now())`
  );
  await pool.query(`INSERT INTO event_customers (event_id, customer_qbo_id) VALUES ($1, 'cust-2')`, [
    fx.eventId,
  ]);

  const result = await adminVoidLine({ eventId: fx.eventId, customerId: 'cust-2', lineId: line.id });
  assert.deepEqual(result, { ok: false, reason: 'unknown-line' });
  assert.equal((await usageForCustomer(fx.eventId, fx.customerId)).length, 1);
});

test('every operation is refused once the customer has been approved', async (t) => {
  if (!dbAvailable) return t.skip();
  await workerLine(3);
  const [line] = await usageForCustomer(fx.eventId, fx.customerId);
  await approve();

  const locked = { ok: false, reason: 'tab-locked' } as const;
  assert.deepEqual(
    await adminSetQty({ eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 9 }),
    locked
  );
  assert.deepEqual(
    await adminAddLine({ eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 9 }),
    locked
  );
  assert.deepEqual(
    await adminVoidLine({ eventId: fx.eventId, customerId: fx.customerId, lineId: line.id }),
    locked
  );

  const live = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(live[0].qty, 3); // untouched
  assert.equal((await actions()).length, 0);
});

test('every operation is refused for a customer not participating in the event', async (t) => {
  if (!dbAvailable) return t.skip();
  await pool.query(
    `INSERT INTO customers (qbo_id, display_name, active, sync_token, raw, synced_at)
     VALUES ('cust-3', 'Not At This Race', true, '0', '{}'::jsonb, now())`
  );
  const missing = { ok: false, reason: 'not-participating' } as const;
  assert.deepEqual(
    await adminSetQty({ eventId: fx.eventId, customerId: 'cust-3', itemId: fx.itemId, qty: 1 }),
    missing
  );
  assert.deepEqual(
    await adminAddLine({ eventId: fx.eventId, customerId: 'cust-3', itemId: fx.itemId, qty: 1 }),
    missing
  );
  assert.deepEqual(await adminVoidLine({ eventId: fx.eventId, customerId: 'cust-3', lineId: 1 }), missing);
});

test('a nonsense quantity is refused before anything is written', async (t) => {
  if (!dbAvailable) return t.skip();
  for (const qty of [0, -1, 1.5, 1000, NaN]) {
    assert.deepEqual(
      await adminSetQty({ eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty }),
      { ok: false, reason: 'invalid-qty' },
      `qty ${qty} should be refused`
    );
  }
  const { rows } = await pool.query('SELECT count(*) FROM submission_lines');
  assert.equal(rows[0].count, '0');
});
