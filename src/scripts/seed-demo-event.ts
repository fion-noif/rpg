// Seed a complete, believable race weekend into the app database: one event, eight workers
// with live magic links, ten participating customers, pre-recorded usage on every one of
// them, a voided line, one customer approved and POSTED to QuickBooks, and one left in
// POST_FAILED.
//
// Usage:
//   npm run seed-demo             # create, or adopt what already exists
//   npm run seed-demo -- --reset  # scrub this event's rows first, then recreate
//
// Everything goes through the real functions — `addWorkerToEvent`, `setUsageQty`,
// `approveBatch`, `postBatch` — rather than raw INSERTs. That is the whole point: a magic
// link is only genuinely valid if it was minted by the code that mints magic links, and a
// POSTED batch only renders correctly if it went through the state machine that posts. A
// seeder that wrote the rows directly would produce data the app has never actually seen.
//
// Requires `npm run sync` first: customers and items are matched by DisplayName and Sku
// against the synced mirror.
import { pool, q } from '../db';
import type { AdminActor } from '../admin/admins';
import { addCustomer, addWorkerToEvent, assign, createEvent } from '../admin/events';
import { setUsageQty } from '../usage';
import { approveBatch, batchFor, postBatch } from '../charges';
import { query as qboQuery, QboError } from '../qbo/client';

const reset = process.argv.slice(2).includes('--reset');

/** `YYYY-MM-DD`, the shape `createEvent` takes. UTC so the string never shifts a day. */
function daysFromToday(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * The weekend, as a manager would enter it. No `code`: it is derived from `startDate` inside
 * `createEvent` (M4), so this script cannot state one up front — and because a second run
 * would derive a *different* suffix, `name` is the key everything below re-finds the event by.
 * That works only because this seeder owns the name and no human ever types it.
 *
 * "(demo)" is load-bearing for the same reason: seed.example.json describes the same weekend,
 * and now that the event is re-found by name rather than by a distinct code, an identical
 * name would make `npm run seed` silently adopt this demo event instead of building its own.
 */
const EVENT = {
  name: '2026 US Karting Championship - Round 7 (demo)',
  // Relative to today, not fixed literals. Worker link expiry is derived from `end_date`
  // (src/workers.ts), so a hard-coded weekend would make every login link this script prints
  // dead on arrival the moment that weekend passed — which is exactly when someone reaches
  // for a demo. A Friday-to-Sunday shape is preserved by ending today and starting two days
  // back.
  startDate: daysFromToday(-2),
  endDate: daysFromToday(0),
};

/**
 * Every action is attributed to the owner. `admin_id` 1 is Mike Rolison, the bootstrap owner
 * created by `npm run create-admin`; §23 Rule 4 wants a name on every audit row, and a
 * seeder has no session to read one from.
 */
const MIKE: AdminActor = { id: 1, name: 'Mike Rolison' };

/** A realistic bilingual crew (design doc §8): most people cover one customer, two cover two. */
const WORKERS: { name: string; language: 'en' | 'es'; customers: string[] }[] = [
  { name: 'Tony Alvarez', language: 'es', customers: ['Rolison Performance Group'] },
  { name: 'Marcus Webb', language: 'en', customers: ['Rolison Performance Group', 'Garcia Racing'] },
  { name: 'José Herrera', language: 'es', customers: ['Chen Racing'] },
  { name: 'Dale Kowalski', language: 'en', customers: ['Chen Racing', 'Miller Motorsports'] },
  { name: 'Luis Ramírez', language: 'es', customers: ['Martínez Karting'] },
  { name: 'Brianna Cole', language: 'en', customers: ['Ibáñez Racing Team'] },
  { name: 'Miguel Castillo', language: 'es', customers: ['Nitro Kart Team'] },
  { name: 'Ryan Petrov', language: 'en', customers: ['Dylan Reyes'] },
];

/**
 * Customers on the entry list. The last two carry no worker assignment on purpose: §21 makes
 * weekend participation a separate step from assignment, and the admin screens have to render
 * a customer nobody is covering yet.
 */
const PARTICIPANTS = [
  'Rolison Performance Group',
  'Garcia Racing',
  'Chen Racing',
  'Miller Motorsports',
  'Martínez Karting',
  'Ibáñez Racing Team',
  'Nitro Kart Team',
  'Dylan Reyes',
  'Sophia Whitaker',
  'Camila Sandoval',
];

/**
 * Pre-recorded usage, `[sku, qty]` per (worker, customer) tab. Rolison Performance Group and
 * Chen Racing each get parts from *two* workers, so the review page's merged running list —
 * and the "who entered this" column — have something real to show.
 */
const USAGE: { worker: string; customer: string; parts: [string, number][] }[] = [
  { worker: 'Tony Alvarez', customer: 'Rolison Performance Group', parts: [['TIRE-SET-MG', 2], ['AX50-M', 1], ['SPR-80T', 2], ['CH219-L', 3], ['BRK-PAD-F', 2], ['OTH-FUEL-JUG', 1]] },
  { worker: 'Marcus Webb', customer: 'Rolison Performance Group', parts: [['ENG-SPARK', 4], ['CH-LUBE', 2], ['HW-BOLT-M8', 1]] },
  { worker: 'Marcus Webb', customer: 'Garcia Racing', parts: [['MG-YEL', 4], ['SPR-76T', 1], ['BRK-FLUID', 2], ['OTH-LABOR', 3]] },
  { worker: 'José Herrera', customer: 'Chen Racing', parts: [['BOD-KIT-CIK', 1], ['BOD-SEAT', 1], ['HW-STEER-WHL', 1]] },
  { worker: 'Dale Kowalski', customer: 'Chen Racing', parts: [['CH-LINK-219', 4], ['SPR-11T', 2]] },
  { worker: 'Dale Kowalski', customer: 'Miller Motorsports', parts: [['ENG-PIST-IAME', 1], ['ENG-GASKET', 2], ['ENG-SPARK', 2], ['OTH-COOL', 1]] },
  { worker: 'Luis Ramírez', customer: 'Martínez Karting', parts: [['TIRE-SET-VEGA', 1], ['AX50-H', 1], ['SPR-84T', 2], ['CH219-S', 1], ['BRK-PAD-R', 1], ['ENG-EXH', 1]] },
  { worker: 'Brianna Cole', customer: 'Ibáñez Racing Team', parts: [['MG-WT', 4], ['BRK-DISC-R', 1], ['OTH-TIRE-GAUGE', 1]] },
  { worker: 'Miguel Castillo', customer: 'Nitro Kart Team', parts: [['ENG-CLUTCH', 1], ['ENG-CARB-KIT', 1], ['HW-TIEROD', 2]] },
  { worker: 'Ryan Petrov', customer: 'Dylan Reyes', parts: [['OTH-STAND', 1], ['HW-ZIP', 2], ['HW-WASH', 1], ['ENG-SPARK', 1]] },
];

/**
 * Corrections: a worker adds a part, then takes it off again. Recorded by writing qty 0,
 * which voids rather than deletes (§31), so the audit section of the review page has content
 * and the export can show a struck-through line.
 */
const VOIDS: { worker: string; customer: string; sku: string }[] = [
  { worker: 'Tony Alvarez', customer: 'Rolison Performance Group', sku: 'OTH-FUEL-JUG' },
  { worker: 'Dale Kowalski', customer: 'Chen Racing', sku: 'SPR-11T' },
];

/** Approved and sent to QuickBooks — the state a tester otherwise has to create themselves. */
const POST_CUSTOMER = 'Martínez Karting';

/**
 * Approved, attempted, and failed. Produced by injecting a `create` that throws instead of
 * calling QuickBooks, so the batch lands in POST_FAILED through the *real* failure path
 * (src/charges.ts `recordFailure`) with no orphaned invoice on the QuickBooks side — the
 * remote call never happens. `deps.query` stays real so the preference pre-flight and the
 * query-before-create both behave exactly as they would in production.
 */
const POST_FAILED_CUSTOMER = 'Nitro Kart Team';

// ---------------------------------------------------------------------------
// --reset
// ---------------------------------------------------------------------------

/**
 * Scrub exactly this event's rows, in FK order.
 *
 * Deliberately narrow: `admins`, `customers` and `items` are never touched. The first is the
 * only way back into the app (Mike's owner account lives there) and the other two are
 * QuickBooks' data, which this app does not own (§3) and cannot recreate without a sync.
 */
async function resetEvent(): Promise<void> {
  const [event] = await q<{ id: number; code: string }>(
    'SELECT id, code FROM events WHERE name = $1 ORDER BY id LIMIT 1',
    [EVENT.name]
  );
  if (!event) {
    console.log(`No existing event "${EVENT.name}" to reset.`);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM submission_lines WHERE submission_id IN (SELECT id FROM submissions WHERE event_id = $1)`,
      [event.id]
    );
    await client.query('UPDATE submissions SET charge_batch_id = NULL WHERE event_id = $1', [event.id]);
    // charge_batch_lines cascades; admin_actions.batch_id is ON DELETE SET NULL.
    await client.query('DELETE FROM charge_batches WHERE event_id = $1', [event.id]);
    await client.query('DELETE FROM submissions WHERE event_id = $1', [event.id]);
    await client.query(
      'DELETE FROM assignments WHERE worker_id IN (SELECT id FROM workers WHERE event_id = $1)',
      [event.id]
    );
    await client.query('DELETE FROM admin_actions WHERE event_id = $1', [event.id]);
    await client.query('DELETE FROM event_customers WHERE event_id = $1', [event.id]);
    await client.query('DELETE FROM workers WHERE event_id = $1', [event.id]);
    // Staff rows are person identities shared across events, so only the ones this scrub
    // orphaned go — and never one belonging to an admin, which would take Mike's
    // attribution with it.
    const staff = await client.query(
      `DELETE FROM staff s
       WHERE s.admin_id IS NULL AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.staff_id = s.id)
       RETURNING s.id`
    );
    await client.query('DELETE FROM events WHERE id = $1', [event.id]);
    await client.query('COMMIT');
    console.log(`Reset event ${event.code}: removed its workers, tabs, batches and ${staff.rowCount} orphaned staff row(s).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(message);
  process.exitCode = 1;
  throw new Error('aborted');
}

try {
  const admin = await q<{ id: number; name: string }>('SELECT id, name FROM admins WHERE id = 1');
  if (!admin[0]) fail('No admin with id 1. Run `npm run create-admin -- mrolison "Mike Rolison" --owner` first.');

  if (reset) await resetEvent();

  // --- Resolve master data before writing anything ------------------------
  const customerIds = new Map<string, string>();
  for (const name of PARTICIPANTS) {
    const [row] = await q<{ qbo_id: string }>(
      'SELECT qbo_id FROM customers WHERE display_name = $1 AND active',
      [name]
    );
    if (!row) fail(`Customer "${name}" is not in the synced customers table. Run \`npm run seed-qbo -- --yes\` then \`npm run sync\`.`);
    customerIds.set(name, row.qbo_id);
  }

  const skus = new Set([...USAGE.flatMap((u) => u.parts.map(([sku]) => sku)), ...VOIDS.map((v) => v.sku)]);
  const itemIds = new Map<string, string>();
  for (const sku of skus) {
    const [row] = await q<{ qbo_id: string }>('SELECT qbo_id FROM items WHERE sku = $1 AND active', [sku]);
    if (!row) fail(`Part with SKU "${sku}" is not in the synced items table. Run \`npm run seed-qbo -- --yes\` then \`npm run sync\`.`);
    itemIds.set(sku, row.qbo_id);
  }

  // --- Event --------------------------------------------------------------
  // Adoption is now decided *before* calling `createEvent` rather than by catching a
  // duplicate afterwards: `createEvent` no longer refuses a repeat, it walks to the next
  // suffix for the same start date (§23 Rule 5 keeps a minted code attached to its invoices),
  // so a blind second call would quietly produce a second Round 7 rather than re-find the
  // first one.
  const [adopted] = await q<{ id: number; code: string }>(
    'SELECT id, code FROM events WHERE name = $1 ORDER BY id LIMIT 1',
    [EVENT.name]
  );
  let eventId: number;
  let eventCode: string;
  if (adopted) {
    eventId = adopted.id;
    eventCode = adopted.code;
    console.log(`Adopted existing event ${eventCode} (id ${eventId}). Pass --reset to rebuild it.`);
  } else {
    const created = await createEvent(EVENT);
    if (!created.ok) fail(`Could not create event "${EVENT.name}": ${created.reason}`);
    eventId = created.eventId;
    eventCode = created.code;
    console.log(`Created event ${eventCode} — ${EVENT.name} (id ${eventId}).`);
  }

  // --- Participation (§21: before any worker or any usage) ----------------
  for (const name of PARTICIPANTS) {
    const result = await addCustomer(eventId, customerIds.get(name)!, MIKE);
    if (!result.ok) fail(`Could not add customer "${name}": ${result.reason}`);
  }
  console.log(`${PARTICIPANTS.length} customers on the entry list.`);

  // --- Workers and assignments -------------------------------------------
  const workerIds = new Map<string, number>();
  const links = new Map<string, string | null>();
  for (const worker of WORKERS) {
    const result = await addWorkerToEvent(
      { eventId, newStaff: { name: worker.name, language: worker.language } },
      MIKE
    );
    if (!result.ok) fail(`Could not add worker "${worker.name}": ${result.reason}`);
    workerIds.set(worker.name, result.workerId);
    links.set(worker.name, result.link);
    for (const customer of worker.customers) {
      const assigned = await assign(result.workerId, customerIds.get(customer)!, MIKE);
      if (!assigned.ok) fail(`Could not assign "${worker.name}" to "${customer}": ${assigned.reason}`);
    }
  }
  console.log(`${WORKERS.length} workers added and assigned.`);

  // --- Usage --------------------------------------------------------------
  let lineCount = 0;
  for (const entry of USAGE) {
    for (const [sku, qty] of entry.parts) {
      const result = await setUsageQty({
        workerId: workerIds.get(entry.worker)!,
        eventId,
        customerId: customerIds.get(entry.customer)!,
        itemId: itemIds.get(sku)!,
        qty,
      });
      if (!result.ok) fail(`Could not record ${sku} x${qty} for "${entry.customer}": ${result.reason}`);
      lineCount += 1;
    }
  }
  for (const v of VOIDS) {
    const result = await setUsageQty({
      workerId: workerIds.get(v.worker)!,
      eventId,
      customerId: customerIds.get(v.customer)!,
      itemId: itemIds.get(v.sku)!,
      qty: 0,
    });
    if (!result.ok) fail(`Could not void ${v.sku} for "${v.customer}": ${result.reason}`);
  }
  console.log(`${lineCount} usage lines recorded; ${VOIDS.length} voided.`);

  // --- One customer approved and POSTED ----------------------------------
  const postCustomerId = customerIds.get(POST_CUSTOMER)!;
  const existingBatch = await batchFor(eventId, postCustomerId);
  if (existingBatch?.status === 'POSTED') {
    console.log(`${POST_CUSTOMER} is already POSTED as ${existingBatch.docNumber}.`);
  } else {
    const approved = await approveBatch({ eventId, customerId: postCustomerId, admin: MIKE });
    if (!approved.ok && approved.reason !== 'already-approved') {
      fail(`Could not approve "${POST_CUSTOMER}": ${approved.reason}`);
    }
    const batch = await batchFor(eventId, postCustomerId);
    const posted = await postBatch(batch!.id, MIKE);
    if (!posted.ok) fail(`Could not post "${POST_CUSTOMER}": ${posted.reason} — ${'message' in posted ? posted.message : ''}`);
    console.log(`${POST_CUSTOMER} POSTED as ${posted.docNumber} (QuickBooks invoice Id ${posted.invoiceId}).`);
  }

  // --- One customer left in POST_FAILED ----------------------------------
  const failCustomerId = customerIds.get(POST_FAILED_CUSTOMER)!;
  const existingFailBatch = await batchFor(eventId, failCustomerId);
  if (existingFailBatch) {
    console.log(`${POST_FAILED_CUSTOMER} already has a batch in ${existingFailBatch.status}.`);
  } else {
    const approved = await approveBatch({ eventId, customerId: failCustomerId, admin: MIKE });
    if (!approved.ok) fail(`Could not approve "${POST_FAILED_CUSTOMER}": ${approved.reason}`);
    const result = await postBatch(approved.batchId, MIKE, {
      query: qboQuery,
      // Never reached in a real run. Throwing a genuine QboError with a 4xx status is what
      // makes the resulting row indistinguishable from a real refusal: `retryable: false`,
      // a fault message on the review page, and post_attempts incremented.
      create: async () => {
        throw new QboError(
          'POST',
          '/invoice',
          400,
          JSON.stringify({
            Fault: {
              Error: [
                {
                  code: '6000',
                  Message: 'Business Validation Error',
                  Detail:
                    'Seeded demo failure: this batch was deliberately left in POST_FAILED so the retry path can be tested. Press Retry to post it for real.',
                },
              ],
            },
          })
        );
      },
    });
    console.log(
      result.ok
        ? `Unexpected: ${POST_FAILED_CUSTOMER} posted.`
        : `${POST_FAILED_CUSTOMER} left in POST_FAILED (retryable: ${'retryable' in result ? result.retryable : 'n/a'}).`
    );
  }

  // --- The links ----------------------------------------------------------
  console.log('');
  console.log(`Event: ${EVENT.name} (${eventCode}) — ${EVENT.startDate} to ${EVENT.endDate}`);
  console.log('');
  console.log(`${'Worker'.padEnd(18)}${'Lang'.padEnd(6)}${'Customers'.padEnd(46)}Login link`);
  console.log('-'.repeat(150));
  for (const worker of WORKERS) {
    const link = links.get(worker.name);
    console.log(
      worker.name.padEnd(18) +
        worker.language.padEnd(6) +
        worker.customers.join(', ').padEnd(46) +
        (link ?? '(already on the event — rotate from /admin, or re-run with --reset)')
    );
  }
  console.log('');
  console.log('Links are personal. A worker who loses theirs needs a rotation, not a copy of');
  console.log("somebody else's. They are minted from APP_BASE_URL — set that to a host the");
  console.log('testers’ phones can actually reach before handing any of these out.');
} catch (err) {
  if ((err as Error).message !== 'aborted') throw err;
} finally {
  await pool.end();
}
