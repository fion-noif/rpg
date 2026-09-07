// End-to-end connectivity check against the real QuickBooks sandbox, driving the production
// code paths — `approveBatch` then `postBatch` — rather than a parallel copy of the
// idempotency logic (it used to be that copy; see plan §4).
//
// It seeds its own TEST event, worker, participation and one recorded part, so it works on a
// fresh database, and it is idempotent on re-run: the second run finds the batch already
// approved and the post adopts the existing sandbox invoice instead of creating another. That
// re-run *is* the §23 Rule 5 assertion.
//
// Usage: npm run test-invoice [-- <customer name substring>]
import { q, pool } from '../db';
import { approveBatch, batchFor, postBatch } from '../charges';
import { setUsageQty } from '../usage';
import { hashToken, newToken } from '../workers';

const EVENT_CODE = 'TEST';
const QTY = 2;

const nameFilter = process.argv[2];

// A numeric QuickBooks id is required to form a DocNumber, which every synced customer has.
const [customer] = await q<{ qbo_id: string; display_name: string }>(
  `SELECT qbo_id, display_name FROM customers
   WHERE active AND qbo_id ~ '^[0-9]{1,9}$' ${nameFilter ? 'AND display_name ILIKE $1' : ''}
   ORDER BY display_name LIMIT 1`,
  nameFilter ? [`%${nameFilter}%`] : []
);
const [item] = await q<{ qbo_id: string; name: string; unit_price: string }>(
  `SELECT qbo_id, name, unit_price FROM items
   WHERE active AND type IN ('NonInventory', 'Service') AND unit_price IS NOT NULL
   ORDER BY name LIMIT 1`
);

if (!customer || !item) {
  console.error('No cached customer or sellable item found. Run `npm run sync` first.');
  process.exit(1);
}

// Approve and post are attributed acts (M3, §23 Rule 4), so this script signs in as the
// owner rather than writing an anonymous audit row. It does not fabricate an identity: if
// there is no owner yet, the honest answer is to go and create one.
const [owner] = await q<{ id: number; name: string }>(
  `SELECT id, name FROM admins WHERE role = 'owner' AND active ORDER BY id LIMIT 1`
);
if (!owner) {
  console.error('No active owner account. Run `npm run create-admin -- <user> "<Name>" --owner` first.');
  process.exit(1);
}
console.log(`Acting as: ${owner.name}`);

// --- Fixture: a TEST event with this customer participating and one part recorded. --------
const [event] = await q<{ id: number }>(
  // Dates are today's: this fixture event exists only to carry a QBO connectivity probe, but
  // it still has to satisfy the NOT NULL dates, and re-running the probe should not leave
  // behind an event whose worker links are already expired.
  `INSERT INTO events (code, name, start_date, end_date)
   VALUES ($1, 'Connectivity test event', CURRENT_DATE, CURRENT_DATE)
   ON CONFLICT (code) DO UPDATE SET name = events.name
   RETURNING id`,
  [EVENT_CODE]
);
const [staff] = await q<{ id: number }>(
  `INSERT INTO staff (name, language)
   SELECT 'Connectivity Test', 'en'
   WHERE NOT EXISTS (SELECT 1 FROM staff WHERE name = 'Connectivity Test')
   RETURNING id`
);
const staffId =
  staff?.id ?? (await q<{ id: number }>(`SELECT id FROM staff WHERE name = 'Connectivity Test'`))[0].id;

await q(
  `INSERT INTO workers (event_id, staff_id, name, language, token_hash)
   VALUES ($1, $2, 'Connectivity Test', 'en', $3)
   ON CONFLICT (event_id, staff_id) DO NOTHING`,
  [event.id, staffId, hashToken(newToken())]
);
const [worker] = await q<{ id: number }>(
  'SELECT id FROM workers WHERE event_id = $1 AND staff_id = $2',
  [event.id, staffId]
);
await q('INSERT INTO event_customers (event_id, customer_qbo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
  event.id,
  customer.qbo_id,
]);
await q('INSERT INTO assignments (worker_id, customer_qbo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
  worker.id,
  customer.qbo_id,
]);

console.log(`Customer: ${customer.display_name} (${customer.qbo_id})`);
console.log(`Item:     ${item.name} @ $${Number(item.unit_price)} × ${QTY}`);

// --- Phase 1: approve ---------------------------------------------------------------------
const write = await setUsageQty({
  workerId: worker.id,
  eventId: event.id,
  customerId: customer.qbo_id,
  itemId: item.qbo_id,
  qty: QTY,
});
// 'tab-locked' on a re-run is expected and correct: the customer is already approved.
if (!write.ok && write.reason !== 'tab-locked') {
  console.error(`Could not record the test part: ${write.reason}`);
  process.exit(1);
}

const approval = await approveBatch({
  eventId: event.id,
  customerId: customer.qbo_id,
  admin: owner,
});
if (approval.ok) {
  console.log(`\nApproved batch ${approval.batchId} — DocNumber ${approval.docNumber}`);
} else if (approval.reason === 'already-approved') {
  console.log('\nAlready approved on a previous run — reusing that batch (this is the point).');
} else {
  console.error(`\nApprove refused: ${approval.reason}`);
  process.exit(1);
}

const batch = await batchFor(event.id, customer.qbo_id);
if (!batch) {
  console.error('No charge batch after approval — this should be impossible.');
  process.exit(1);
}

// --- Phase 2: post ------------------------------------------------------------------------
const posted = await postBatch(batch.id, owner);
if (!posted.ok) {
  console.error(`\nPost failed (${posted.reason}): ${'message' in posted ? posted.message : ''}`);
  if ('retryable' in posted && posted.retryable) {
    console.error('Retryable — run this script again.');
  }
  await pool.end();
  process.exit(1);
}

console.log(
  posted.adopted
    ? `\nAdopted the existing sandbox invoice Id ${posted.invoiceId} — no duplicate created.`
    : `\nCreated draft invoice Id ${posted.invoiceId} (DocNumber ${posted.docNumber}).`
);
if (posted.docNumberMismatch) {
  console.warn(
    'WARNING: QuickBooks assigned its own DocNumber. Turn on Settings → Account and settings →\n' +
      'Sales → "Custom transaction numbers", otherwise DocNumber-based idempotency cannot work.'
  );
}
console.log('Re-run this script to verify idempotency (it should adopt, not duplicate).');
await pool.end();
