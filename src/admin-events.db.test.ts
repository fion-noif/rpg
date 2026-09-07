// Integration tests for admin event setup, against a real Postgres database (the "test"
// script in package.json points DATABASE_URL at a separate racing_test database). If that
// database isn't reachable every case here is skipped rather than failed — see the `before`
// hook — so `npm test` still passes in an environment with no Postgres.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db';
import { workerByToken } from './workers';
import { setUsageQty } from './usage';
import { applySchema, resetSchema, seedAdmin, seedFixtures, type Fixtures } from './test-helpers';
import type { AdminActor } from './admin/admins';
import { createStaff, listStaff } from './admin/staff';
import {
  addCustomer,
  addWorkerToEvent,
  assign,
  closeEvent,
  createEvent,
  listCustomers,
  listEvents,
  listWorkers,
  removeCustomer,
  removeWorkerFromEvent,
  rotateWorkerToken,
  unassign,
  updateEventDates,
} from './admin/events';
import { docNumberFor } from './charges';

let dbAvailable = true;
let fx: Fixtures;
/** Every logged event-setup mutation names its actor now (M3). */
let admin: AdminActor;

before(async () => {
  try {
    await pool.query('SELECT 1');
    await applySchema(pool);
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `\nSkipping src/admin-events.db.test.ts — no reachable test database (${(err as Error).message}).\n` +
        'Run `npm run db:up`, then `docker compose exec db psql -U racing -c "CREATE DATABASE racing_test"`.\n'
    );
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await resetSchema(pool);
  fx = await seedFixtures(pool);
  admin = await seedAdmin(pool, { username: 'mike', name: 'Mike Rolison' });
});

after(async () => {
  await pool.end();
});

/** The plaintext token out of a one-time magic link, for exercising workerByToken. */
function tokenOf(link: string): string {
  const token = link.split('/login/')[1];
  assert.ok(token, `link has no token: ${link}`);
  return token;
}

/**
 * A weekend that is running *now*, so the worker links it mints resolve (link expiry is
 * derived from `end_date` — see src/workers.db.test.ts). Tests that care about a specific
 * code assert on the value `createEvent` returns rather than predicting it.
 */
function today(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function freshEvent(name = 'Round 8'): Promise<number> {
  const created = await createEvent({ name, startDate: today(), endDate: today(1) });
  assert.equal(created.ok, true);
  return created.ok ? created.eventId : 0;
}

/** For the few assertions about a code: read the generated one instead of predicting it. */
async function codeOf(eventId: number): Promise<string> {
  const res = await pool.query<{ code: string }>('SELECT code FROM events WHERE id = $1', [eventId]);
  return res.rows[0].code;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test('createEvent derives the code from the start date and stores the dates', async (t) => {
  if (!dbAvailable) return t.skip();
  const created = await createEvent({
    name: 'Round 8 — Laguna Seca',
    startDate: '2026-09-04',
    endDate: '2026-09-06',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.code, '260904');

  const stored = await pool.query(
    `SELECT code, name, active, closed_at, to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(end_date, 'YYYY-MM-DD') AS end_date
     FROM events WHERE id = $1`,
    [created.eventId]
  );
  assert.deepEqual(stored.rows[0], {
    code: '260904',
    name: 'Round 8 — Laguna Seca',
    active: true,
    closed_at: null,
    start_date: '2026-09-04',
    end_date: '2026-09-06',
  });
});

test('a generated code always fits the QuickBooks DocNumber budget', async (t) => {
  if (!dbAvailable) return t.skip();
  const created = await createEvent({ name: 'Budget', startDate: '2026-12-31', endDate: '2026-12-31' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  // The whole point of deriving the code: 6 digits leaves slack the old hand-typed 8-char
  // ceiling spent. The worst legal customer id in src/charges.test.ts is 9 digits.
  assert.ok(docNumberFor(created.code, '123456789').length <= 21);
});

test('two events starting the same day get suffixed codes, not a collision', async (t) => {
  if (!dbAvailable) return t.skip();
  const first = await createEvent({ name: 'Paddock A', startDate: '2026-09-04', endDate: '2026-09-06' });
  const second = await createEvent({ name: 'Paddock B', startDate: '2026-09-04', endDate: '2026-09-06' });
  const third = await createEvent({ name: 'Paddock C', startDate: '2026-09-04', endDate: '2026-09-06' });
  assert.equal(first.ok && first.code, '260904');
  assert.equal(second.ok && second.code, '260904B');
  assert.equal(third.ok && third.code, '260904C');

  // Three distinct events, not one renamed three times.
  const count = await pool.query(`SELECT count(*) FROM events WHERE code LIKE '260904%'`);
  assert.equal(count.rows[0].count, '3');
});

test('createEvent rejects unusable dates and names before touching the DB', async (t) => {
  if (!dbAvailable) return t.skip();
  const cases: [string, string][] = [
    ['', '2026-09-06'],
    ['2026-09-04', ''],
    ['not-a-date', '2026-09-06'],
    ['2026-9-4', '2026-09-06'], // unpadded — the browser never sends this, a seed file might
    ['2026-02-31', '2026-03-01'], // passes the regex, is not a day
    ['2026-09-06', '2026-09-04'], // ends before it starts
  ];
  for (const [startDate, endDate] of cases) {
    assert.deepEqual(
      await createEvent({ name: 'Nope', startDate, endDate }),
      { ok: false, reason: 'invalid-dates' },
      `expected reject: ${startDate} → ${endDate}`
    );
  }
  assert.deepEqual(
    await createEvent({ name: '   ', startDate: '2026-09-04', endDate: '2026-09-06' }),
    { ok: false, reason: 'invalid-name' }
  );

  // The DB CHECK and the NOT NULLs are backstops, but nothing should have reached them.
  const count = await pool.query('SELECT count(*) FROM events');
  assert.equal(count.rows[0].count, '1'); // just the fixture event
});

test('a single-day event is legal', async (t) => {
  if (!dbAvailable) return t.skip();
  const created = await createEvent({ name: 'Test day', startDate: '2026-09-04', endDate: '2026-09-04' });
  assert.equal(created.ok, true);
});

test('updateEventDates moves the dates, logs both sides, and never touches the code', async (t) => {
  if (!dbAvailable) return t.skip();
  const created = await createEvent({ name: 'Ran long', startDate: '2026-09-04', endDate: '2026-09-06' });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // The weekend overran: Sunday became Monday.
  assert.deepEqual(
    await updateEventDates(created.eventId, { startDate: '2026-09-04', endDate: '2026-09-07' }, admin),
    { ok: true }
  );

  const stored = await pool.query(
    `SELECT code, to_char(end_date, 'YYYY-MM-DD') AS end_date FROM events WHERE id = $1`,
    [created.eventId]
  );
  assert.equal(stored.rows[0].end_date, '2026-09-07');
  // Still 260904, not re-derived: by now it may be printed on a posted invoice (§23 Rule 5).
  assert.equal(stored.rows[0].code, '260904');

  const logged = await pool.query(
    `SELECT detail FROM admin_actions WHERE action = 'edit-event-dates' AND event_id = $1`,
    [created.eventId]
  );
  assert.equal(logged.rows.length, 1);
  assert.equal(logged.rows[0].detail.from.endDate, '2026-09-06');
  assert.equal(logged.rows[0].detail.to.endDate, '2026-09-07');
  assert.equal(logged.rows[0].detail.by, admin.name);
});

test('updateEventDates refuses bad dates, unknown events, and closed events', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();

  assert.deepEqual(
    await updateEventDates(eventId, { startDate: '2026-09-06', endDate: '2026-09-04' }, admin),
    { ok: false, reason: 'invalid-dates' }
  );
  assert.deepEqual(
    await updateEventDates(999_999, { startDate: '2026-09-04', endDate: '2026-09-06' }, admin),
    { ok: false, reason: 'unknown-event' }
  );

  // Closed is settled history: the tokens are already destroyed, so moving the dates could
  // not restore access and would only make the audit log describe something that never ran.
  assert.equal((await closeEvent(eventId, admin, { force: true })).ok, true);
  assert.deepEqual(
    await updateEventDates(eventId, { startDate: '2026-09-04', endDate: '2026-09-06' }, admin),
    { ok: false, reason: 'event-closed' }
  );
});

test('listEvents summarises participation and batch status per event', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();
  await addCustomer(eventId, fx.customerId, admin);
  const added = await addWorkerToEvent({ eventId, newStaff: { name: 'Nia' } }, admin);
  assert.equal(added.ok, true);

  const events = await listEvents();
  const r8 = events.find((e) => e.id === eventId);
  assert.ok(r8);
  assert.equal(r8.customerCount, 1);
  assert.equal(r8.workerCount, 1);
  assert.equal(r8.openCount, 1); // nothing approved yet
  assert.equal(r8.approvedCount, 0);
  assert.equal(r8.postedCount, 0);
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

test('addCustomer is idempotent, listCustomers shows assigned worker names', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();

  assert.deepEqual(await addCustomer(eventId, fx.customerId, admin), { ok: true, added: true });
  assert.deepEqual(await addCustomer(eventId, fx.customerId, admin), { ok: true, added: false });
  assert.deepEqual(await addCustomer(eventId, 'no-such-customer', admin), {
    ok: false,
    reason: 'unknown-customer',
  });
  assert.deepEqual(await addCustomer(999_999, fx.customerId, admin), { ok: false, reason: 'unknown-event' });

  let customers = await listCustomers(eventId);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].qboId, fx.customerId);
  assert.deepEqual(customers[0].workers, []);
  assert.equal(customers[0].batchStatus, null);

  const worker = await addWorkerToEvent({ eventId, newStaff: { name: 'Nia' } }, admin);
  assert.ok(worker.ok);
  await assign(worker.workerId, fx.customerId);

  customers = await listCustomers(eventId);
  assert.deepEqual(customers[0].workers, ['Nia']);

  // The fixture event's workers are assigned to the same customer but must not leak here.
  assert.equal(customers[0].workers.length, 1);
});

test('removeCustomer undoes a mis-add but is refused once there is history', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();
  const worker = await addWorkerToEvent({ eventId, newStaff: { name: 'Nia' } }, admin);
  assert.ok(worker.ok);
  await assign(worker.workerId, fx.customerId);

  // Clean removal also drops the assignment, so the worker stops seeing the customer.
  assert.deepEqual(await removeCustomer(eventId, fx.customerId, admin), { ok: true });
  assert.deepEqual(await listCustomers(eventId), []);
  const assignments = await pool.query('SELECT count(*) FROM assignments WHERE worker_id = $1', [
    worker.workerId,
  ]);
  assert.equal(assignments.rows[0].count, '0');

  assert.deepEqual(await removeCustomer(eventId, fx.customerId, admin), {
    ok: false,
    reason: 'not-participating',
  });

  // Now record something, and the participation row becomes load-bearing history (§31).
  await assign(worker.workerId, fx.customerId);
  const wrote = await setUsageQty({
    workerId: worker.workerId,
    eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty: 2,
  });
  assert.equal(wrote.ok, true);

  assert.deepEqual(await removeCustomer(eventId, fx.customerId, admin), {
    ok: false,
    reason: 'has-submissions',
  });
  assert.equal((await listCustomers(eventId)).length, 1); // nothing was removed
});

// ---------------------------------------------------------------------------
// Workers and credentials
// ---------------------------------------------------------------------------

test('addWorkerToEvent creates the person, returns a working link, and is idempotent', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();

  const added = await addWorkerToEvent({ eventId, newStaff: { name: 'Nia', language: 'es' } }, admin);
  assert.ok(added.ok);
  assert.ok(added.link, 'a brand-new participation must return its one-time link');
  assert.equal(added.name, 'Nia');

  // The link actually authenticates, and carries the language copied from staff.
  const session = await workerByToken(tokenOf(added.link));
  assert.ok(session);
  assert.equal(session.id, added.workerId);
  assert.equal(session.staff_id, added.staffId);
  assert.equal(session.language, 'es');
  assert.equal(session.event_code, await codeOf(eventId));

  // Only the hash is stored — the plaintext exists nowhere in the database.
  const stored = await pool.query('SELECT token_hash FROM workers WHERE id = $1', [added.workerId]);
  assert.notEqual(stored.rows[0].token_hash, tokenOf(added.link));

  // Re-adding the same person: same worker row, and no link, because the token is not
  // recoverable from its hash. The UI offers "rotate" instead.
  const again = await addWorkerToEvent({ eventId, staffId: added.staffId }, admin);
  assert.ok(again.ok);
  assert.equal(again.workerId, added.workerId);
  assert.equal(again.link, null);

  // …and the original link still works: a duplicate add must not rotate someone out
  // mid-weekend.
  assert.ok(await workerByToken(tokenOf(added.link)));

  const workers = await listWorkers(eventId);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].hasToken, true);
});

test('addWorkerToEvent picks an existing person by id and rejects unknown ids and blank names', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();

  const created = await createStaff({ name: 'Existing Person', language: 'es' });
  assert.ok(created.ok);
  const added = await addWorkerToEvent({ eventId, staffId: created.staffId }, admin);
  assert.ok(added.ok);
  assert.equal(added.name, 'Existing Person');
  assert.equal(added.staffId, created.staffId);

  assert.deepEqual(await addWorkerToEvent({ eventId, staffId: 999_999 }, admin), {
    ok: false,
    reason: 'unknown-staff',
  });
  assert.deepEqual(await addWorkerToEvent({ eventId, newStaff: { name: '  ' } }, admin), {
    ok: false,
    reason: 'invalid-name',
  });
  // The rejected new-person add must not have left an orphan staff row behind.
  const staff = await listStaff();
  assert.equal(staff.filter((s) => s.name.trim() === '').length, 0);
  assert.equal(staff.find((s) => s.id === created.staffId)?.eventCount, 1);
});

test('rotateWorkerToken issues a new link and kills the old one immediately', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();
  const added = await addWorkerToEvent({ eventId, newStaff: { name: 'Nia' } }, admin);
  assert.ok(added.ok && added.link);
  const oldToken = tokenOf(added.link);

  const rotated = await rotateWorkerToken(added.workerId, admin);
  assert.ok(rotated.ok);
  const newToken = tokenOf(rotated.link);
  assert.notEqual(newToken, oldToken);

  assert.equal(await workerByToken(oldToken), undefined);
  assert.equal((await workerByToken(newToken))?.id, added.workerId);

  assert.deepEqual(await rotateWorkerToken(999_999, admin), { ok: false, reason: 'unknown-worker' });
});

test('removeWorkerFromEvent undoes a mis-add but never destroys entry history', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();
  await addCustomer(eventId, fx.customerId, admin);

  const mistake = await addWorkerToEvent({ eventId, newStaff: { name: 'Wrong Person' } }, admin);
  assert.ok(mistake.ok && mistake.link);
  await assign(mistake.workerId, fx.customerId);
  assert.deepEqual(await removeWorkerFromEvent(mistake.workerId, admin), { ok: true });
  assert.equal(await workerByToken(tokenOf(mistake.link)), undefined);
  assert.equal((await listWorkers(eventId)).length, 0);

  const real = await addWorkerToEvent({ eventId, newStaff: { name: 'Nia' } }, admin);
  assert.ok(real.ok);
  await assign(real.workerId, fx.customerId);
  await setUsageQty({
    workerId: real.workerId,
    eventId,
    customerId: fx.customerId,
    itemId: fx.itemId,
    qty: 1,
  });
  assert.deepEqual(await removeWorkerFromEvent(real.workerId, admin), {
    ok: false,
    reason: 'has-submissions',
  });
  assert.equal((await listWorkers(eventId)).length, 1);

  assert.deepEqual(await removeWorkerFromEvent(999_999, admin), { ok: false, reason: 'unknown-worker' });
});

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

test('assign creates the participation row in the same transaction (§21)', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();
  const worker = await addWorkerToEvent({ eventId, newStaff: { name: 'Nia' } }, admin);
  assert.ok(worker.ok);

  // No addCustomer call — assigning implies participation.
  assert.deepEqual(await listCustomers(eventId), []);
  assert.deepEqual(await assign(worker.workerId, fx.customerId), { ok: true });

  const customers = await listCustomers(eventId);
  assert.equal(customers.length, 1);
  assert.equal(customers[0].qboId, fx.customerId);
  assert.deepEqual((await listWorkers(eventId))[0].customers, [fx.customerId]);

  // Repeat assign is a no-op, not a unique violation.
  assert.deepEqual(await assign(worker.workerId, fx.customerId), { ok: true });
  assert.equal((await listWorkers(eventId))[0].customers.length, 1);

  // Unassign narrows access but leaves participation alone.
  assert.deepEqual(await unassign(worker.workerId, fx.customerId), { ok: true });
  assert.deepEqual((await listWorkers(eventId))[0].customers, []);
  assert.equal((await listCustomers(eventId)).length, 1);

  assert.deepEqual(await assign(worker.workerId, 'no-such-customer'), {
    ok: false,
    reason: 'unknown-customer',
  });
  assert.deepEqual(await assign(999_999, fx.customerId), { ok: false, reason: 'unknown-worker' });
});

// ---------------------------------------------------------------------------
// Closing the event
// ---------------------------------------------------------------------------

test('closeEvent refuses while customers are unposted, then force closes and destroys links', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();
  await addCustomer(eventId, fx.customerId, admin);
  const worker = await addWorkerToEvent({ eventId, newStaff: { name: 'Nia' } }, admin);
  assert.ok(worker.ok && worker.link);
  const token = tokenOf(worker.link);
  assert.ok(await workerByToken(token));

  const refused = await closeEvent(eventId, admin);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.reason === 'unposted-customers');
  if (!refused.ok && refused.reason === 'unposted-customers') {
    assert.equal(refused.customers.length, 1);
    assert.equal(refused.customers[0].qboId, fx.customerId);
    assert.equal(refused.customers[0].status, 'NOT_APPROVED');
  }
  // A refused close changes nothing — most importantly, the link still works.
  const stillOpen = await pool.query('SELECT active, closed_at FROM events WHERE id = $1', [eventId]);
  assert.equal(stillOpen.rows[0].active, true);
  assert.equal(stillOpen.rows[0].closed_at, null);
  assert.ok(await workerByToken(token));

  const forced = await closeEvent(eventId, admin, { force: true });
  assert.deepEqual(forced, { ok: true, tokensRevoked: 1 });

  const closed = await pool.query('SELECT active, closed_at FROM events WHERE id = $1', [eventId]);
  assert.equal(closed.rows[0].active, false);
  assert.notEqual(closed.rows[0].closed_at, null);

  // §8: the credential is gone, not flagged — hash NULLed and the token no longer resolves.
  assert.equal(await workerByToken(token), undefined);
  const revoked = await pool.query('SELECT token_hash, token_revoked_at FROM workers WHERE id = $1', [
    worker.workerId,
  ]);
  assert.equal(revoked.rows[0].token_hash, null);
  assert.notEqual(revoked.rows[0].token_revoked_at, null);

  const logged = await pool.query(
    `SELECT detail FROM admin_actions WHERE action = 'close-event' AND event_id = $1`,
    [eventId]
  );
  assert.equal(logged.rows.length, 1);
  assert.equal(logged.rows[0].detail.forced, true);
  assert.equal(logged.rows[0].detail.tokensRevoked, 1);
  assert.equal(logged.rows[0].detail.unposted.length, 1);

  assert.deepEqual(await closeEvent(eventId, admin), { ok: false, reason: 'already-closed' });
  assert.deepEqual(await closeEvent(999_999, admin), { ok: false, reason: 'unknown-event' });
});

test('closeEvent needs no override once every participating customer is POSTED', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();
  await addCustomer(eventId, fx.customerId, admin);

  await pool.query(
    `INSERT INTO charge_batches (event_id, customer_qbo_id, doc_number, status, posted_at)
     VALUES ($1, $2, $3, 'POSTED', now())`,
    [eventId, fx.customerId, `RW-R8-${fx.customerId}`]
  );

  assert.deepEqual(await closeEvent(eventId, admin), { ok: true, tokensRevoked: 0 });
});

test('a closed event refuses every further mutation', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();
  const worker = await addWorkerToEvent({ eventId, newStaff: { name: 'Nia' } }, admin);
  assert.ok(worker.ok);
  await assign(worker.workerId, fx.customerId);
  assert.equal((await closeEvent(eventId, admin, { force: true })).ok, true);

  assert.deepEqual(await addCustomer(eventId, fx.customerId, admin), { ok: false, reason: 'event-closed' });
  assert.deepEqual(await removeCustomer(eventId, fx.customerId, admin), { ok: false, reason: 'event-closed' });
  assert.deepEqual(await addWorkerToEvent({ eventId, newStaff: { name: 'Late' } }, admin), {
    ok: false,
    reason: 'event-closed',
  });
  assert.deepEqual(await rotateWorkerToken(worker.workerId, admin), { ok: false, reason: 'event-closed' });
  assert.deepEqual(await removeWorkerFromEvent(worker.workerId, admin), { ok: false, reason: 'event-closed' });
  assert.deepEqual(await assign(worker.workerId, fx.customerId), { ok: false, reason: 'event-closed' });
  assert.deepEqual(await unassign(worker.workerId, fx.customerId), { ok: false, reason: 'event-closed' });
});

// ---------------------------------------------------------------------------
// Staff picker
// ---------------------------------------------------------------------------

test('listStaff carries the last event worked, and never offers the synthetic manager', async (t) => {
  if (!dbAvailable) return t.skip();
  const eventId = await freshEvent();
  const added = await addWorkerToEvent({ eventId, newStaff: { name: 'Nia' } }, admin);
  assert.ok(added.ok);

  // The manager is modelled as an is_admin worker with its own staff row (db/schema.sql).
  const managerStaff = await createStaff({ name: 'Manager' });
  assert.ok(managerStaff.ok);
  await pool.query(
    `INSERT INTO workers (event_id, staff_id, name, is_admin) VALUES ($1, $2, 'Manager', TRUE)`,
    [eventId, managerStaff.staffId]
  );

  const staff = await listStaff();
  assert.equal(
    staff.some((s) => s.id === managerStaff.staffId),
    false,
    'the synthetic manager must not appear in the worker picker'
  );

  const nia = staff.find((s) => s.id === added.staffId);
  assert.ok(nia);
  assert.equal(nia.eventCount, 1);
  assert.equal(nia.lastEventCode, await codeOf(eventId));
  assert.notEqual(nia.lastEventAt, null);

  // Names are not deduplicated: §23 Rule 1 forbids identity-by-name.
  const dupe = await createStaff({ name: 'Nia' });
  assert.ok(dupe.ok);
  assert.notEqual(dupe.staffId, added.staffId);
  assert.equal((await listStaff()).filter((s) => s.name === 'Nia').length, 2);

  assert.deepEqual(await createStaff({ name: '   ' }), { ok: false, reason: 'invalid-name' });
});
