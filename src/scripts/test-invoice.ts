// Create one draft Invoice via the API, exercising the idempotency
// mechanism from design doc §23 Rule 5 (deterministic DocNumber + query-before-create).
// Kept from M0 (ported to Postgres); becomes the basis of M2's Approve & Post.
//
// Usage: npm run test-invoice [-- <customer name substring>]
import { q, pool } from '../db';
import { query, create } from '../qbo/client';

const EVENT_CODE = 'TEST';

const nameFilter = process.argv[2];
const [customer] = await q<{ qbo_id: string; display_name: string }>(
  `SELECT qbo_id, display_name FROM customers
   WHERE active ${nameFilter ? 'AND display_name ILIKE $1' : ''}
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
const unitPrice = Number(item.unit_price);

const docNumber = `RW-${EVENT_CODE}-${customer.qbo_id}`;
console.log(`Customer: ${customer.display_name} (${customer.qbo_id})`);
console.log(`Item:     ${item.name} @ $${unitPrice}`);
console.log(`DocNumber: ${docNumber}`);

// Rule 5 step 3: query-before-create.
const existing = (await query(`select * from Invoice where DocNumber = '${docNumber}'`)).Invoice?.[0];

let invoice = existing;
if (existing) {
  console.log(`\nInvoice already exists in QuickBooks (Id ${existing.Id}) — adopting it, not creating a duplicate.`);
} else {
  invoice = await create('Invoice', {
    CustomerRef: { value: customer.qbo_id },
    DocNumber: docNumber,
    PrivateNote: `racing-app ${EVENT_CODE} batch for customer ${customer.qbo_id}`,
    Line: [
      {
        DetailType: 'SalesItemLineDetail',
        Amount: unitPrice * 2,
        Description: item.name,
        SalesItemLineDetail: { ItemRef: { value: item.qbo_id }, Qty: 2, UnitPrice: unitPrice },
      },
    ],
  });
  console.log(`\nCreated draft invoice Id ${invoice.Id}, total $${invoice.TotalAmt}.`);
  if (invoice.DocNumber !== docNumber) {
    console.warn(
      `WARNING: QuickBooks assigned DocNumber "${invoice.DocNumber}" instead of "${docNumber}".\n` +
        'Enable Settings → Account and settings → Sales → "Custom transaction numbers" in QuickBooks,\n' +
        'otherwise DocNumber-based idempotency will not work.'
    );
  }
}

await q(
  `INSERT INTO events (code, name) VALUES ($1, 'Connectivity test event') ON CONFLICT (code) DO NOTHING`,
  [EVENT_CODE]
);
await q(
  `INSERT INTO charge_batches (event_id, customer_qbo_id, doc_number, qbo_invoice_id, qbo_sync_token, status, posted_at)
   VALUES ((SELECT id FROM events WHERE code = $1), $2, $3, $4, $5, 'POSTED', now())
   ON CONFLICT (doc_number) DO UPDATE SET
     qbo_invoice_id = $4, qbo_sync_token = $5, status = 'POSTED', posted_at = now()`,
  [EVENT_CODE, customer.qbo_id, docNumber, invoice.Id, invoice.SyncToken]
);

console.log('Charge batch recorded locally. Re-run this script to verify idempotency (it should adopt, not duplicate).');
await pool.end();
