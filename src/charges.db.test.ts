// Integration tests for the Approve & Post state machine against a real Postgres database.
// Skipped rather than failed when the racing_test database is unreachable (see `before`).
//
// QuickBooks is always a fake here, injected through `postBatch`'s `deps`. The fake counts its
// calls, because most of what this file asserts is a *negative*: no second create, ever.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db';
import { setUsageQty } from './usage';
import { approveBatch, batchFor, batchWithLines, postBatch, unapproveBatch } from './charges';
import { QboError } from './qbo/client';
import { clearPreferencesCache } from './qbo/invoice';
import { applySchema, resetSchema, seedAdmin, seedFixtures, type Fixtures } from './test-helpers';
import type { AdminActor } from './admin/admins';

let dbAvailable = true;
let fx: Fixtures;
let admin: AdminActor;

/**
 * The seed customer id in test-helpers is `cust-1`, which deliberately cannot form a DocNumber
 * (`RW-{code}-{id}` requires a numeric QuickBooks id). Posting tests therefore need a customer
 * that looks like a real QuickBooks one, so this adds a second participating customer with a
 * numeric id and points both seeded workers at it.
 */
const CUSTOMER = '58';

async function seedApprovableCustomer(): Promise<void> {
  await pool.query(
    `INSERT INTO customers (qbo_id, display_name, active, sync_token, raw, synced_at)
     VALUES ($1, 'Postable Customer', true, '0', '{}'::jsonb, now())`,
    [CUSTOMER]
  );
  await pool.query('INSERT INTO event_customers (event_id, customer_qbo_id) VALUES ($1, $2)', [
    fx.eventId,
    CUSTOMER,
  ]);
  await pool.query(
    'INSERT INTO assignments (worker_id, customer_qbo_id) VALUES ($1, $3), ($2, $3)',
    [fx.workerAId, fx.workerBId, CUSTOMER]
  );
}

/** Records a part on a worker's tab through the real worker path, so tabs/statuses are real. */
async function record(workerId: number, itemId: string, qty: number): Promise<void> {
  const res = await setUsageQty({ workerId, eventId: fx.eventId, customerId: CUSTOMER, itemId, qty });
  assert.equal(res.ok, true, `seed write failed: ${JSON.stringify(res)}`);
}

interface Fake {
  deps: {
    query: (sql: string) => Promise<any>;
    create: (entity: string, body: any) => Promise<any>;
    afterCreate?: () => Promise<void>;
  };
  queries: string[];
  creates: any[];
}

/**
 * A fake QuickBooks. `existing` is what a DocNumber lookup finds (undefined = nothing yet);
 * `onCreate` returns the created invoice or throws. `customTxnNumbers` defaults to on because
 * every test but the pre-flight one is about something else.
 */
function fakeQbo(opts: {
  existing?: { Id: string; SyncToken: string; DocNumber?: string };
  onCreate?: (body: any) => any;
  customTxnNumbers?: boolean;
  afterCreate?: () => Promise<void>;
}): Fake {
  const queries: string[] = [];
  const creates: any[] = [];
  const fake: Fake = {
    queries,
    creates,
    deps: {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('Preferences')) {
          return { Preferences: [{ SalesFormsPrefs: { CustomTxnNumbers: opts.customTxnNumbers !== false } }] };
        }
        return opts.existing ? { Invoice: [opts.existing] } : {};
      },
      async create(_entity: string, body: any) {
        creates.push(body);
        if (opts.onCreate) return opts.onCreate(body);
        return { Id: '9001', SyncToken: '0', DocNumber: body.DocNumber };
      },
      afterCreate: opts.afterCreate,
    },
  };
  return fake;
}

async function statuses(): Promise<string[]> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM submissions WHERE event_id = $1 AND customer_qbo_id = $2 ORDER BY worker_id`,
    [fx.eventId, CUSTOMER]
  );
  return res.rows.map((r) => r.status);
}

async function actions(): Promise<{ action: string; admin_id: number | null; detail: any }[]> {
  // Excludes the 'create-admin' row seedAdmin writes — this helper is about billing actions.
  const res = await pool.query<{ action: string; admin_id: number | null; detail: any }>(
    `SELECT action, admin_id, detail FROM admin_actions
     WHERE action IN ('approve', 'post', 'post-failed', 'unapprove') ORDER BY id`
  );
  return res.rows;
}

before(async () => {
  try {
    await pool.query('SELECT 1');
    await applySchema(pool);
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `\nSkipping src/charges.db.test.ts — no reachable test database (${(err as Error).message}).\n` +
        'Run `npm run db:up`, then `docker compose exec db psql -U racing -c "CREATE DATABASE racing_test"`.\n'
    );
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await resetSchema(pool);
  fx = await seedFixtures(pool);
  // Approve and post are attributed acts now (M3) — the actor is part of the fixture.
  admin = await seedAdmin(pool, { username: 'mike', name: 'Mike Rolison' });
  await seedApprovableCustomer();
  // The Preferences check is cached per process; each test picks its own answer.
  clearPreferencesCache();
});

after(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

test('approve aggregates two workers\' tabs into one line per item', async (t) => {
  if (!dbAvailable) return t.skip();
  await record(fx.workerAId, fx.itemId, 3);
  await record(fx.workerBId, fx.itemId, 2);

  const result = await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin });
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.docNumber, `RW-T1-${CUSTOMER}`);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].qty, 5);
  assert.equal(result.lines[0].unitPrice, 9.5);
  assert.equal(result.lines[0].itemName, 'Test Part');

  const logged = await actions();
  assert.deepEqual(logged.map((a) => a.action), ['approve']);
  assert.equal(logged[0].detail.total, 47.5);
});

test('approve flips every tab to APPROVED and locks further writes', async (t) => {
  if (!dbAvailable) return t.skip();
  await record(fx.workerAId, fx.itemId, 1);
  await record(fx.workerBId, fx.itemId, 1);

  const approved = await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin });
  assert.ok(approved.ok);
  assert.deepEqual(await statuses(), ['APPROVED', 'APPROVED']);

  // Both the worker with a tab and (via the participation probe) any worker without one.
  const blocked = await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: CUSTOMER,
    itemId: fx.itemId,
    qty: 9,
  });
  assert.deepEqual(blocked, { ok: false, reason: 'tab-locked' });

  const batch = await batchWithLines(approved.batchId);
  assert.equal(batch?.lines[0].qty, 2, 'the post-approval write must not have changed the aggregate');
});

test('every tab is stamped with the batch it was folded into', async (t) => {
  if (!dbAvailable) return t.skip();
  await record(fx.workerAId, fx.itemId, 1);
  const approved = await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin });
  assert.ok(approved.ok);
  const res = await pool.query<{ charge_batch_id: number }>(
    'SELECT charge_batch_id FROM submissions WHERE customer_qbo_id = $1',
    [CUSTOMER]
  );
  assert.deepEqual(res.rows, [{ charge_batch_id: approved.batchId }]);
});

test('a second approve is refused and leaves exactly one batch', async (t) => {
  if (!dbAvailable) return t.skip();
  await record(fx.workerAId, fx.itemId, 1);
  assert.ok((await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin })).ok);

  const second = await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin });
  assert.deepEqual(second, { ok: false, reason: 'already-approved' });

  const count = await pool.query('SELECT count(*)::int AS n FROM charge_batches');
  assert.equal(count.rows[0].n, 1);
  const lines = await pool.query('SELECT count(*)::int AS n FROM charge_batch_lines');
  assert.equal(lines.rows[0].n, 1);
});

test('concurrent approves: exactly one wins', async (t) => {
  if (!dbAvailable) return t.skip();
  await record(fx.workerAId, fx.itemId, 1);
  const [a, b] = await Promise.all([
    approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin }),
    approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin }),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  const count = await pool.query('SELECT count(*)::int AS n FROM charge_batches');
  assert.equal(count.rows[0].n, 1);
});

test('voided lines are excluded from the approved aggregate', async (t) => {
  if (!dbAvailable) return t.skip();
  await record(fx.workerAId, fx.itemId, 4);
  await record(fx.workerBId, fx.itemId, 6);
  // Worker B changes their mind: qty 0 voids their line.
  await record(fx.workerBId, fx.itemId, 0);

  const result = await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin });
  assert.ok(result.ok);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].qty, 4);
});

test('distinct price snapshots for the same part become two invoice lines', async (t) => {
  if (!dbAvailable) return t.skip();
  await record(fx.workerAId, fx.itemId, 2); // snapshots 9.50
  await pool.query('UPDATE items SET unit_price = 11 WHERE qbo_id = $1', [fx.itemId]);
  await record(fx.workerBId, fx.itemId, 3); // snapshots 11.00

  const result = await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin });
  assert.ok(result.ok);
  // Collapsing them would need a unit price matching neither, and the total would drift.
  assert.deepEqual(
    result.lines
      .map((l) => [l.unitPrice, l.qty])
      .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
    [[9.5, 2], [11, 3]]
  );
  assert.equal((await actions())[0].detail.total, 52);
});

test('a part that went inactive in QuickBooks refuses the whole batch, persisting nothing', async (t) => {
  if (!dbAvailable) return t.skip();
  await record(fx.workerAId, fx.itemId, 2);
  // Rule 3: the part was sellable when recorded and is not any more.
  await pool.query('UPDATE items SET active = FALSE WHERE qbo_id = $1', [fx.itemId]);

  const result = await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === 'inactive-item');
  assert.deepEqual(result.items, [{ itemQboId: fx.itemId, itemName: 'Test Part' }]);

  // The claim INSERT ran before the check, so this asserts the rollback, not just the reason.
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM charge_batches')).rows[0].n, 0);
  assert.deepEqual(await statuses(), ['SUBMITTED']);
  assert.deepEqual(await actions(), []);
});

test('a customer with nothing recorded cannot be approved', async (t) => {
  if (!dbAvailable) return t.skip();
  const result = await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin });
  assert.deepEqual(result, { ok: false, reason: 'nothing-to-approve' });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM charge_batches')).rows[0].n, 0);
});

test('a non-participating customer and a closed event are both refused', async (t) => {
  if (!dbAvailable) return t.skip();
  assert.deepEqual(await approveBatch({ eventId: fx.eventId, customerId: '999', admin }), {
    ok: false,
    reason: 'not-participating',
  });

  await record(fx.workerAId, fx.itemId, 1);
  await pool.query('UPDATE events SET closed_at = now() WHERE id = $1', [fx.eventId]);
  assert.deepEqual(await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin }), {
    ok: false,
    reason: 'event-closed',
  });
});

test('a customer whose QuickBooks id cannot form a DocNumber is refused, not truncated', async (t) => {
  if (!dbAvailable) return t.skip();
  // fx.customerId is 'cust-1' — not a QuickBooks-shaped id.
  await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty: 1,
  });
  assert.deepEqual(await approveBatch({ eventId: fx.eventId, customerId: fx.customerId, admin }), {
    ok: false,
    reason: 'unusable-doc-number',
  });
});

// ---------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------

/** Approve a small batch and return its id — the starting point for every posting test. */
async function approved(): Promise<number> {
  await record(fx.workerAId, fx.itemId, 2);
  const result = await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin });
  assert.ok(result.ok);
  return result.batchId;
}

test('post creates the draft invoice and records it, mirroring the tabs', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();
  const qbo = fakeQbo({});

  const result = await postBatch(batchId, admin, qbo.deps);
  assert.ok(result.ok);
  assert.equal(result.adopted, false);
  assert.equal(result.invoiceId, '9001');
  assert.equal(result.docNumberMismatch, false);

  // The body was built from charge_batch_lines, not from the live tabs.
  assert.equal(qbo.creates.length, 1);
  assert.equal(qbo.creates[0].DocNumber, `RW-T1-${CUSTOMER}`);
  assert.deepEqual(qbo.creates[0].Line[0].SalesItemLineDetail, {
    ItemRef: { value: fx.itemId },
    Qty: 2,
    UnitPrice: 9.5,
  });
  assert.equal(qbo.creates[0].Line[0].Amount, 19);

  const batch = await batchFor(fx.eventId, CUSTOMER);
  assert.equal(batch?.status, 'POSTED');
  assert.equal(batch?.qboInvoiceId, '9001');
  assert.equal(batch?.qboSyncToken, '0');
  assert.equal(batch?.postAttempts, 1);
  assert.equal(batch?.postError, null);
  assert.ok(batch?.postedAt);
  assert.deepEqual(await statuses(), ['POSTED_TO_QUICKBOOKS']);
  assert.deepEqual((await actions()).map((a) => a.action), ['approve', 'post']);
});

test('post adopts an invoice that already exists under the same DocNumber', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();
  const qbo = fakeQbo({ existing: { Id: '7', SyncToken: '3', DocNumber: `RW-T1-${CUSTOMER}` } });

  const result = await postBatch(batchId, admin, qbo.deps);
  assert.ok(result.ok);
  assert.equal(result.adopted, true);
  assert.equal(result.invoiceId, '7');
  assert.equal(qbo.creates.length, 0, 'adopting must never create');

  const batch = await batchFor(fx.eventId, CUSTOMER);
  assert.equal(batch?.status, 'POSTED');
  assert.equal(batch?.qboInvoiceId, '7');
  assert.equal(batch?.qboSyncToken, '3');
});

test('posting an already-posted batch is refused without touching QuickBooks', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();
  assert.ok((await postBatch(batchId, admin, fakeQbo({}).deps)).ok);

  const qbo = fakeQbo({});
  assert.deepEqual(await postBatch(batchId, admin, qbo.deps), { ok: false, reason: 'already-posted' });
  assert.equal(qbo.queries.length, 0);
  assert.equal(qbo.creates.length, 0);
});

test('an unknown batch id is reported as such', async (t) => {
  if (!dbAvailable) return t.skip();
  assert.deepEqual(await postBatch(987654, admin, fakeQbo({}).deps), { ok: false, reason: 'unknown-batch' });
});

test('a QuickBooks 400 records POST_FAILED verbatim and is not retryable', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();
  const body = JSON.stringify({
    Fault: {
      Error: [{ code: '6140', Message: 'Duplicate Document Number', Detail: 'Duplicate Doc Number' }],
    },
  });
  const qbo = fakeQbo({
    onCreate: () => {
      throw new QboError('POST', '/invoice', 400, body);
    },
  });

  const result = await postBatch(batchId, admin, qbo.deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === 'qbo-error');
  assert.equal(result.retryable, false, 'a 4xx means QuickBooks understood us and said no');
  assert.match(result.message, /6140/);
  assert.match(result.message, /Duplicate Document Number/);

  const batch = await batchFor(fx.eventId, CUSTOMER);
  assert.equal(batch?.status, 'POST_FAILED');
  assert.equal(batch?.qboInvoiceId, null);
  assert.equal(batch?.postAttempts, 1);
  assert.match(batch?.postError ?? '', /Duplicate Document Number/);
  // POST_FAILED on submissions is finally reachable (design doc §26).
  assert.deepEqual(await statuses(), ['POST_FAILED']);
  assert.deepEqual((await actions()).map((a) => a.action), ['approve', 'post-failed']);
});

test('a 5xx and a network failure are both marked retryable', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();

  const serverError = await postBatch(
    batchId,
    admin,
    fakeQbo({
      onCreate: () => {
        throw new QboError('POST', '/invoice', 503, 'service unavailable');
      },
    }).deps
  );
  assert.ok(!serverError.ok && serverError.reason === 'qbo-error' && serverError.retryable);

  const network = await postBatch(
    batchId,
    admin,
    fakeQbo({
      onCreate: () => {
        throw new TypeError('fetch failed');
      },
    }).deps
  );
  assert.ok(!network.ok && network.reason === 'qbo-error' && network.retryable);
  assert.match(network.message, /Could not reach QuickBooks/);
  assert.equal((await batchFor(fx.eventId, CUSTOMER))?.postAttempts, 2);
});

test('retry after a failure clears the error and posts, restoring the tabs', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();
  await postBatch(
    batchId,
    admin,
    fakeQbo({
      onCreate: () => {
        throw new QboError('POST', '/invoice', 503, 'try later');
      },
    }).deps
  );
  assert.deepEqual(await statuses(), ['POST_FAILED']);

  const qbo = fakeQbo({});
  const retried = await postBatch(batchId, admin, qbo.deps);
  assert.ok(retried.ok);
  assert.equal(qbo.creates.length, 1);

  const batch = await batchFor(fx.eventId, CUSTOMER);
  assert.equal(batch?.status, 'POSTED');
  assert.equal(batch?.postError, null);
  assert.equal(batch?.postAttempts, 2);
  assert.deepEqual(await statuses(), ['POSTED_TO_QUICKBOOKS']);
});

test('crash between create and record: the retry adopts, it does not create a second invoice', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();

  // The dangerous window: QuickBooks created the invoice, then this process died before it
  // could write the id down. `afterCreate` throws exactly there.
  const crashed = fakeQbo({
    afterCreate: async () => {
      throw new Error('container killed after create');
    },
  });
  const first = await postBatch(batchId, admin, crashed.deps);
  assert.equal(first.ok, false);
  assert.equal(crashed.creates.length, 1);
  const afterCrash = await batchFor(fx.eventId, CUSTOMER);
  assert.equal(afterCrash?.status, 'POST_FAILED');
  assert.equal(afterCrash?.qboInvoiceId, null, 'the invoice id was genuinely lost');

  // The orphan is now discoverable only by its deterministic DocNumber — which is the point.
  const retry = fakeQbo({ existing: { Id: '9001', SyncToken: '0', DocNumber: `RW-T1-${CUSTOMER}` } });
  const second = await postBatch(batchId, admin, retry.deps);
  assert.ok(second.ok);
  assert.equal(second.adopted, true);
  assert.equal(retry.creates.length, 0, 'no duplicate charge');
  assert.equal((await batchFor(fx.eventId, CUSTOMER))?.qboInvoiceId, '9001');
});

test('custom transaction numbers off blocks the post before anything is created', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();
  const qbo = fakeQbo({ customTxnNumbers: false });

  const result = await postBatch(batchId, admin, qbo.deps);
  assert.ok(!result.ok && result.reason === 'blocked');
  assert.equal(result.retryable, true, 'fix the setting in QuickBooks, then Retry');
  assert.match(result.message, /Custom transaction numbers/);
  assert.equal(qbo.creates.length, 0);
  assert.equal((await batchFor(fx.eventId, CUSTOMER))?.status, 'POST_FAILED');
});

test('an invoice QuickBooks renamed is still recorded, flagged as a DocNumber mismatch', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();
  // Custom transaction numbers raced off between the pre-flight and the create.
  const qbo = fakeQbo({ onCreate: () => ({ Id: '1234', SyncToken: '0', DocNumber: '1057' }) });

  const result = await postBatch(batchId, admin, qbo.deps);
  assert.ok(result.ok);
  assert.equal(result.docNumberMismatch, true);

  const batch = await batchFor(fx.eventId, CUSTOMER);
  // Never orphan a created invoice: the id is stored even though idempotency is unverifiable.
  assert.equal(batch?.qboInvoiceId, '1234');
  assert.equal(batch?.docNumberMismatch, true);
  assert.equal(batch?.status, 'POSTED');
});

// ---------------------------------------------------------------------------
// Un-approve
// ---------------------------------------------------------------------------

test('un-approve restores SUBMITTED tabs, deletes the batch, and snapshots the aggregate', async (t) => {
  if (!dbAvailable) return t.skip();
  await record(fx.workerAId, fx.itemId, 2);
  await record(fx.workerBId, fx.itemId, 1);
  const result = await approveBatch({ eventId: fx.eventId, customerId: CUSTOMER, admin });
  assert.ok(result.ok);

  assert.deepEqual(await unapproveBatch(result.batchId, admin), {
    ok: true,
    eventId: fx.eventId,
    customerQboId: CUSTOMER,
  });

  assert.equal((await pool.query('SELECT count(*)::int AS n FROM charge_batches')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM charge_batch_lines')).rows[0].n, 0);
  assert.deepEqual(await statuses(), ['SUBMITTED', 'SUBMITTED']);

  const logged = await actions();
  assert.deepEqual(logged.map((a) => a.action), ['approve', 'unapprove']);
  // What was approved and then withdrawn survives the deletion.
  assert.equal(logged[1].detail.batchId, result.batchId);
  assert.equal(logged[1].detail.docNumber, `RW-T1-${CUSTOMER}`);
  assert.equal(logged[1].detail.lines.length, 1);
  assert.equal(logged[1].detail.lines[0].qty, 3);
  assert.equal(logged[1].detail.total, 28.5);

  // And the customer is editable again.
  const write = await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: CUSTOMER,
    itemId: fx.itemId,
    qty: 5,
  });
  assert.equal(write.ok, true);
});

test('un-approve is refused once a post has been attempted — retry resolves the unknown first', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();
  await postBatch(
    batchId,
    admin,
    fakeQbo({
      onCreate: () => {
        throw new QboError('POST', '/invoice', 503, 'timeout');
      },
    }).deps
  );

  assert.deepEqual(await unapproveBatch(batchId, admin), { ok: false, reason: 'has-post-attempts' });
  assert.equal((await batchFor(fx.eventId, CUSTOMER))?.id, batchId, 'the batch must survive');
});

test('un-approve is refused for a posted batch and for an unknown id', async (t) => {
  if (!dbAvailable) return t.skip();
  const batchId = await approved();
  assert.ok((await postBatch(batchId, admin, fakeQbo({}).deps)).ok);

  assert.deepEqual(await unapproveBatch(batchId, admin), { ok: false, reason: 'posted' });
  assert.deepEqual(await unapproveBatch(987654, admin), { ok: false, reason: 'unknown-batch' });
});
