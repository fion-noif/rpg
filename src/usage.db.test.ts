// Integration tests for the server-side usage log, against a real Postgres database (the
// "test" script in package.json points DATABASE_URL at a separate racing_test database).
// If that database isn't reachable, every case here is skipped rather than failed — see the
// `before` hook — so `npm test` still passes in an environment with no Postgres.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db';
import { setUsageQty, usageForCustomer } from './usage';
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
      `\nSkipping src/usage.db.test.ts — no reachable test database (${(err as Error).message}).\n` +
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

test('first write creates exactly one tab and one line, snapshotting the item price', async (t) => {
  if (!dbAvailable) return t.skip();
  const result = await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty: 3,
  });
  assert.equal(result.ok, true);

  const lines = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 3);
  assert.equal(lines[0].unitPrice, 9.5);

  const { rows } = await pool.query('SELECT count(*) FROM submissions');
  assert.equal(rows[0].count, '1');
});

test('a second write for the same item sets qty rather than incrementing, reusing the tab', async (t) => {
  if (!dbAvailable) return t.skip();
  await setUsageQty({ workerId: fx.workerAId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 3 });
  await setUsageQty({ workerId: fx.workerAId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 7 });

  const lines = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 7);

  const { rows } = await pool.query('SELECT count(*) FROM submissions');
  assert.equal(rows[0].count, '1');
});

test('idempotency: the identical write applied three times leaves qty unchanged', async (t) => {
  if (!dbAvailable) return t.skip();
  for (let i = 0; i < 3; i++) {
    await setUsageQty({ workerId: fx.workerAId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 4 });
  }
  const lines = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 4);
});

test('qty 0 voids the line (not deletes it); a later add creates a fresh live line', async (t) => {
  if (!dbAvailable) return t.skip();
  await setUsageQty({ workerId: fx.workerAId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 2 });
  const voided = await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty: 0,
  });
  assert.equal(voided.ok, true);
  assert.equal(voided.ok && voided.line, null);

  let lines = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(lines.length, 0);

  const { rows: raw } = await pool.query('SELECT voided_at FROM submission_lines');
  assert.equal(raw.length, 1); // row survives — soft delete, not a real delete
  assert.notEqual(raw[0].voided_at, null);

  await setUsageQty({ workerId: fx.workerAId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 5 });
  lines = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 5);

  const { rows: raw2 } = await pool.query('SELECT count(*) FROM submission_lines');
  assert.equal(raw2[0].count, '2'); // the voided row plus the fresh live one
});

test('each worker keeps an independent line for the same item; both are visible together', async (t) => {
  if (!dbAvailable) return t.skip();
  await setUsageQty({ workerId: fx.workerAId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 2 });
  await setUsageQty({ workerId: fx.workerBId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 5 });

  const lines = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(lines.length, 2);
  const byWorker = new Map(lines.map((l) => [l.workerId, l.qty]));
  assert.equal(byWorker.get(fx.workerAId), 2);
  assert.equal(byWorker.get(fx.workerBId), 5);

  // Worker B's write only ever touches worker B's own tab — ownership is structural, so
  // there's no cross-worker collision to reject.
  await setUsageQty({ workerId: fx.workerBId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 9 });
  const after = await usageForCustomer(fx.eventId, fx.customerId);
  const byWorkerAfter = new Map(after.map((l) => [l.workerId, l.qty]));
  assert.equal(byWorkerAfter.get(fx.workerAId), 2);
  assert.equal(byWorkerAfter.get(fx.workerBId), 9);
});

test('an unknown or inactive item is rejected and nothing is committed', async (t) => {
  if (!dbAvailable) return t.skip();
  const r1 = await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: 'does-not-exist',
    qty: 1,
  });
  assert.deepEqual(r1, { ok: false, reason: 'unknown-item' });

  const r2 = await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.inactiveItemId,
    qty: 1,
  });
  assert.deepEqual(r2, { ok: false, reason: 'unknown-item' });

  const { rows } = await pool.query('SELECT count(*) FROM submissions');
  assert.equal(rows[0].count, '0'); // the whole transaction rolls back, including the tab
});

test('writes are rejected once the tab is no longer SUBMITTED', async (t) => {
  if (!dbAvailable) return t.skip();
  await setUsageQty({ workerId: fx.workerAId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 1 });
  await pool.query(`UPDATE submissions SET status = 'APPROVED' WHERE worker_id = $1`, [fx.workerAId]);

  const result = await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty: 2,
  });
  assert.deepEqual(result, { ok: false, reason: 'tab-locked' });

  const lines = await usageForCustomer(fx.eventId, fx.customerId);
  assert.equal(lines[0].qty, 1); // unchanged
});

test('concurrent first writes to a new tab still produce exactly one tab', async (t) => {
  if (!dbAvailable) return t.skip();
  await Promise.all([
    setUsageQty({ workerId: fx.workerAId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 1 }),
    setUsageQty({ workerId: fx.workerAId, eventId: fx.eventId, customerId: fx.customerId, itemId: fx.itemId, qty: 2 }),
  ]);
  const { rows } = await pool.query('SELECT count(*) FROM submissions WHERE worker_id = $1', [fx.workerAId]);
  assert.equal(rows[0].count, '1');
});
