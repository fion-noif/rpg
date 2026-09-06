// Integration tests for the worker/manager visibility split (owner's decision 09/06/2026),
// against a real Postgres database. Same skip-if-unreachable contract as the other `.db`
// suites: no reachable `racing_test` means every case here skips rather than fails.
//
// The pure half of this feature is tested in src/qbo/catalog.test.ts. What can only be tested
// here is that the SQL fragments actually *run* — and, more importantly, that the split is an
// authorisation boundary and not just a filter on a dropdown: a worker holding a real service
// item's QuickBooks id must be refused by the write path, in the transaction.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db';
import { setUsageQty } from './usage';
import { adminAddLine } from './admin-review';
import { approveBatch, batchWithLines } from './charges';
import { buildInvoiceBody } from './qbo/invoice';
import { managerSellableItemSql, workerVisibleItemSql } from './catalog';
import { applySchema, resetSchema, seedAdmin, seedFixtures, type Fixtures } from './test-helpers';

let dbAvailable = true;
let fx: Fixtures;
let admin: { id: number; name: string };

before(async () => {
  try {
    await pool.query('SELECT 1');
    await applySchema(pool);
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `\nSkipping src/catalog.db.test.ts — no reachable test database (${(err as Error).message}).\n` +
        'Run `npm run db:up`, then `docker compose exec db psql -U racing -c "CREATE DATABASE racing_test"`.\n'
    );
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await resetSchema(pool);
  fx = await seedFixtures(pool);
  const seeded = await seedAdmin(pool, { username: 'mgr', name: 'Manager Under Test' });
  admin = { id: seeded.id, name: seeded.name };
});

after(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// The two catalogue reads, run as SQL against real rows
// ---------------------------------------------------------------------------

test("the worker's catalogue query excludes services and SKU-less stock items", async (t) => {
  if (!dbAvailable) return t.skip();
  const { rows } = await pool.query<{ qbo_id: string }>(
    `SELECT qbo_id FROM items WHERE ${workerVisibleItemSql()} ORDER BY qbo_id`
  );
  assert.deepEqual(
    rows.map((r) => r.qbo_id),
    [fx.itemId],
    'only the active, SKU-bearing part is worker-visible'
  );
});

test("the manager's catalogue query includes the part AND the service", async (t) => {
  if (!dbAvailable) return t.skip();
  const { rows } = await pool.query<{ qbo_id: string }>(
    `SELECT qbo_id FROM items WHERE ${managerSellableItemSql()} ORDER BY qbo_id`
  );
  // The part plus the categorised service — and still not the inactive part, nor the
  // uncategorised stock `Services` row, which belongs to nobody's picker.
  assert.deepEqual(rows.map((r) => r.qbo_id).sort(), [fx.itemId, fx.serviceItemId].sort());
});

test('the aliased fragment runs in the popular-parts join without an ambiguous column', async (t) => {
  if (!dbAvailable) return t.skip();
  // A worker records a part; a manager adds a service. Only the part may come back.
  await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty: 4,
  });
  const added = await adminAddLine({
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.serviceItemId,
    qty: 9,
    admin,
  });
  assert.equal(added.ok, true);

  const { rows } = await pool.query<{ id: string }>(
    `SELECT l.item_qbo_id AS id
     FROM submission_lines l
     JOIN submissions s ON s.id = l.submission_id
     JOIN items i ON i.qbo_id = l.item_qbo_id
     WHERE s.event_id = $1 AND l.voided_at IS NULL AND ${workerVisibleItemSql('i')}
     GROUP BY l.item_qbo_id ORDER BY SUM(l.qty) DESC LIMIT 5`,
    [fx.eventId]
  );
  // The service has the higher quantity, so it would top this list if it were not filtered.
  assert.deepEqual(
    rows.map((r) => r.id),
    [fx.itemId]
  );
});

// ---------------------------------------------------------------------------
// The authorisation boundary
// ---------------------------------------------------------------------------

test('a worker cannot record a service item even holding its real QuickBooks id', async (t) => {
  if (!dbAvailable) return t.skip();
  const result = await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.serviceItemId,
    qty: 3,
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'unknown-item');

  // Nothing committed — not the line, and not the tab the write would have created on its
  // way to the line. A rejection that still leaves a submission row behind would make an
  // empty tab appear on the manager's review page from a request that was refused.
  const lines = await pool.query('SELECT count(*)::int AS n FROM submission_lines');
  assert.equal(lines.rows[0].n, 0);
  const tabs = await pool.query('SELECT count(*)::int AS n FROM submissions');
  assert.equal(tabs.rows[0].n, 0);
});

test("a worker cannot record Intuit's SKU-less stock Services item either", async (t) => {
  if (!dbAvailable) return t.skip();
  // The belt-and-braces case: this row has no category at all, so only the
  // `sku IS NOT NULL` clause stops it. This is the assertion that stays true even if the
  // seeder's re-parent of items 1 and 2 is refused by QuickBooks.
  const result = await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.uncategorizedServiceItemId,
    qty: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'unknown-item');
});

test('a manager CAN add the same service item a worker was refused', async (t) => {
  if (!dbAvailable) return t.skip();
  const result = await adminAddLine({
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.serviceItemId,
    qty: 3, // three race days
    admin,
  });

  assert.equal(result.ok, true);
  assert.ok(result.ok && result.line);
  assert.equal(result.ok && result.line!.qty, 3);
  assert.equal(result.ok && result.line!.unitPrice, 100);
  assert.equal(result.ok && result.line!.sku, 'SVC-TEST-DAY');

  // Attributed to the manager by name, on their own synthetic worker's tab, like any other
  // §17 adjustment — the service path reuses adminAddLine rather than duplicating it.
  const { rows } = await pool.query<{ name: string; is_admin: boolean; action: string }>(
    `SELECT w.name, w.is_admin, a.action
     FROM submission_lines l
     JOIN submissions s ON s.id = l.submission_id
     JOIN workers w ON w.id = s.worker_id
     JOIN admin_actions a ON a.event_id = s.event_id AND a.admin_id = $1
     WHERE l.voided_at IS NULL`,
    [admin.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Manager Under Test');
  assert.equal(rows[0].is_admin, true);
  assert.equal(rows[0].action, 'add-line');
});

test('a manager still cannot add the uncategorised stock service item', async (t) => {
  if (!dbAvailable) return t.skip();
  // Widening the manager's reach to services did not widen it to *everything* active: an
  // item with neither a SKU nor a manager-only category is in nobody's catalogue.
  const result = await adminAddLine({
    eventId: fx.eventId,
    customerId: fx.customerId,
    itemId: fx.uncategorizedServiceItemId,
    qty: 1,
    admin,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'unknown-item');
});

// ---------------------------------------------------------------------------
// A service line all the way to the invoice body
// ---------------------------------------------------------------------------

/**
 * `fx.customerId` is `cust-1`, which deliberately cannot form a DocNumber (§23 Rule 5 needs
 * a numeric QuickBooks id), so the approve path needs a customer that looks like a real one.
 * Same helper as src/charges.db.test.ts.
 */
const POSTABLE_CUSTOMER = '58';

async function seedApprovableCustomer(): Promise<void> {
  await pool.query(
    `INSERT INTO customers (qbo_id, display_name, active, sync_token, raw, synced_at)
     VALUES ($1, 'Postable Customer', true, '0', '{}'::jsonb, now())`,
    [POSTABLE_CUSTOMER]
  );
  await pool.query('INSERT INTO event_customers (event_id, customer_qbo_id) VALUES ($1, $2)', [
    fx.eventId,
    POSTABLE_CUSTOMER,
  ]);
  await pool.query('INSERT INTO assignments (worker_id, customer_qbo_id) VALUES ($1, $2)', [
    fx.workerAId,
    POSTABLE_CUSTOMER,
  ]);
}

test('a service line flows into charge_batch_lines and into the invoice body', async (t) => {
  if (!dbAvailable) return t.skip();
  await seedApprovableCustomer();

  // A worker's parts, plus a manager-added service line billed in days.
  await setUsageQty({
    workerId: fx.workerAId,
    eventId: fx.eventId,
    customerId: POSTABLE_CUSTOMER,
    itemId: fx.itemId,
    qty: 4, // 4 × 9.50 = 38.00
  });
  const service = await adminAddLine({
    eventId: fx.eventId,
    customerId: POSTABLE_CUSTOMER,
    itemId: fx.serviceItemId,
    qty: 3, // 3 days × 100 = 300.00
    admin,
  });
  assert.equal(service.ok, true, JSON.stringify(service));

  const approved = await approveBatch({ eventId: fx.eventId, customerId: POSTABLE_CUSTOMER, admin });
  assert.ok(approved.ok, `approve failed: ${JSON.stringify(approved)}`);

  const stored = await batchWithLines(approved.batchId);
  assert.ok(stored);
  assert.equal(stored!.lines.length, 2);

  const serviceLine = stored!.lines.find((l) => l.itemQboId === fx.serviceItemId);
  assert.ok(serviceLine, 'the service line was snapshotted into charge_batch_lines');
  assert.equal(serviceLine!.qty, 3);
  assert.equal(serviceLine!.unitPrice, 100);
  assert.equal(serviceLine!.sku, 'SVC-TEST-DAY');

  const body = buildInvoiceBody({
    customerQboId: POSTABLE_CUSTOMER,
    docNumber: approved.docNumber,
    eventCode: 'T1',
    lines: stored!.lines.map((l) => ({
      itemQboId: l.itemQboId,
      itemName: l.itemName,
      qty: l.qty,
      unitPrice: l.unitPrice,
    })),
  });

  const bodyLines = body.Line as {
    Amount: number;
    Description: string;
    SalesItemLineDetail: { ItemRef: { value: string }; Qty: number; UnitPrice?: number };
  }[];
  assert.equal(bodyLines.length, 2);

  const invoiced = bodyLines.find((l) => l.SalesItemLineDetail.ItemRef.value === fx.serviceItemId);
  assert.ok(invoiced, 'the service reached the invoice body');
  assert.equal(invoiced!.SalesItemLineDetail.Qty, 3, 'Qty is a whole number of days');
  assert.equal(invoiced!.SalesItemLineDetail.UnitPrice, 100, 'UnitPrice is the day rate');
  assert.equal(invoiced!.Amount, 300, 'Amount is days × day rate');

  // The tax-inclusive invariant (§28 n.28): the invoice total is exactly sum(qty × price)
  // over parts and services alike, with nothing added and no tax field anywhere in the body.
  const invoiceTotal = bodyLines.reduce((sum, l) => sum + l.Amount, 0);
  assert.equal(invoiceTotal, 338);
  assert.equal(
    stored!.lines.reduce((sum, l) => sum + l.qty * (l.unitPrice ?? 0), 0),
    invoiceTotal,
    'the approved total and the invoiced total are the same number'
  );
  assert.ok(!('TxnTaxDetail' in body), 'the app never sends tax detail');
  assert.ok(!JSON.stringify(body).includes('TaxCodeRef'), 'the app never sends a tax code');
});
