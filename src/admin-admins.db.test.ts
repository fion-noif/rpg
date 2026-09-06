// Account management against a real database. Same skip-if-unreachable contract as the other
// .db tests.
//
// The cases worth having here are the guards, not the happy paths: what stops the owner from
// locking themselves out, what a duplicate username does, and what the login path is willing
// to say about why it refused.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db';
import {
  authenticateAdmin,
  changeOwnPassword,
  createAdmin,
  getAdmin,
  hasAnyAdmin,
  listAdmins,
  resetAdminPassword,
  setAdminActive,
} from './admin/admins';
import { applySchema, resetSchema, seedAdmin } from './test-helpers';

let dbAvailable = true;
let mike: { id: number; username: string; name: string; password: string };

before(async () => {
  try {
    await pool.query('SELECT 1');
    await applySchema(pool);
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `\nSkipping src/admin-admins.db.test.ts — no reachable test database (${(err as Error).message}).\n` +
        'Run `npm run db:up`, then `docker compose exec db psql -U racing -c "CREATE DATABASE racing_test"`.\n'
    );
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await resetSchema(pool);
  mike = await seedAdmin(pool, { username: 'mike', name: 'Mike Rolison', role: 'owner' });
});

after(async () => {
  await pool.end();
});

async function auditFor(adminId: number): Promise<string[]> {
  const { rows } = await pool.query<{ action: string }>(
    'SELECT action FROM admin_actions WHERE admin_id = $1 ORDER BY id',
    [adminId]
  );
  return rows.map((r) => r.action);
}

test('bootstrap: hasAnyAdmin, and the first owner comes from the CLI with no actor', async (t) => {
  if (!dbAvailable) return t.skip();
  assert.equal(await hasAnyAdmin(), true);
  await resetSchema(pool);
  assert.equal(await hasAnyAdmin(), false);

  // `by: null` is the bootstrap case — there is no admin yet to attribute it to, so the audit
  // row is deliberately unattributed rather than falsely self-attributed.
  const created = await createAdmin({ username: 'mike', name: 'Mike Rolison', role: 'owner' }, null);
  assert.ok(created.ok);
  const { rows } = await pool.query(
    `SELECT admin_id, detail FROM admin_actions WHERE action = 'create-admin'`
  );
  assert.equal(rows[0].admin_id, null);
  assert.equal(rows[0].detail.by, 'cli');
});

test('createAdmin generates a working one-time password and stores only its hash', async (t) => {
  if (!dbAvailable) return t.skip();
  const created = await createAdmin({ username: 'jane', name: 'Jane Smith', role: 'manager' }, mike);
  assert.ok(created.ok);
  assert.equal(created.tempPassword.length, 12);

  const { rows } = await pool.query('SELECT password_hash FROM admins WHERE id = $1', [created.id]);
  assert.match(rows[0].password_hash, /^scrypt\$/);
  assert.ok(!rows[0].password_hash.includes(created.tempPassword));

  assert.equal((await authenticateAdmin('jane', created.tempPassword)).ok, true);
  assert.deepEqual(await auditFor(mike.id), ['create-admin']);
});

test('usernames are normalised, validated, and unique', async (t) => {
  if (!dbAvailable) return t.skip();
  // Case and surrounding whitespace are not identity — 'Jane' and 'jane' are one account.
  const created = await createAdmin({ username: '  JANE  ', name: 'Jane Smith', role: 'manager' }, mike);
  assert.ok(created.ok);
  assert.equal(created.username, 'jane');

  assert.deepEqual(await createAdmin({ username: 'jane', name: 'Someone Else', role: 'manager' }, mike), {
    ok: false,
    reason: 'duplicate-username',
  });

  for (const bad of ['j', 'Jane Smith', 'jane@example.com', '-jane', '', 'a'.repeat(33)]) {
    assert.deepEqual(
      await createAdmin({ username: bad, name: 'Someone', role: 'manager' }, mike),
      { ok: false, reason: 'invalid-username' },
      `expected reject: ${JSON.stringify(bad)}`
    );
  }
  assert.deepEqual(await createAdmin({ username: 'ok2', name: '   ', role: 'manager' }, mike), {
    ok: false,
    reason: 'invalid-name',
  });
});

test('authenticateAdmin distinguishes its refusals internally but never returns the hash', async (t) => {
  if (!dbAvailable) return t.skip();
  // The route collapses all three into one message; these reasons exist for the log and here.
  assert.deepEqual(await authenticateAdmin('nobody', 'whatever'), {
    ok: false,
    reason: 'unknown-username',
  });
  assert.deepEqual(await authenticateAdmin('mike', 'wrong'), { ok: false, reason: 'wrong-password' });

  const ok = await authenticateAdmin('MIKE', mike.password);
  assert.ok(ok.ok);
  assert.deepEqual(Object.keys(ok.admin).sort(), [
    'active',
    'createdAt',
    'id',
    'name',
    'role',
    'tokenVersion',
    'username',
  ]);

  // A deactivated account still has its hash verified before being turned away, so the
  // response time does not distinguish "switched off" from "wrong password".
  const jane = await seedAdmin(pool, { username: 'jane', name: 'Jane Smith', role: 'manager' });
  await setAdminActive(jane.id, false, mike);
  assert.deepEqual(await authenticateAdmin('jane', jane.password), { ok: false, reason: 'inactive' });
  assert.deepEqual(await authenticateAdmin('jane', 'wrong'), { ok: false, reason: 'wrong-password' });
});

test('an owner cannot deactivate themselves', async (t) => {
  if (!dbAvailable) return t.skip();
  // Guarded because it would lock them out of the only page that could undo it.
  assert.deepEqual(await setAdminActive(mike.id, false, mike), { ok: false, reason: 'self' });
  const still = await getAdmin(mike.id);
  assert.equal(still?.active, true);
  assert.equal(still?.tokenVersion, 1); // refused before any write
});

test('the last active owner cannot be deactivated by another owner', async (t) => {
  if (!dbAvailable) return t.skip();
  const second = await seedAdmin(pool, { username: 'ops', name: 'Ops Owner', role: 'owner' });

  // Two owners: either can deactivate the other.
  assert.deepEqual(await setAdminActive(mike.id, false, second), { ok: true, active: false });
  // Now `second` is the last one standing, and Mike (deactivated) cannot take them down with him.
  assert.deepEqual(await setAdminActive(second.id, false, mike), { ok: false, reason: 'last-owner' });

  // A manager is not an owner, so deactivating them is never blocked by this guard.
  const jane = await seedAdmin(pool, { username: 'jane', name: 'Jane Smith', role: 'manager' });
  assert.deepEqual(await setAdminActive(jane.id, false, second), { ok: true, active: false });
});

test('setAdminActive and resetAdminPassword refuse an unknown id', async (t) => {
  if (!dbAvailable) return t.skip();
  assert.deepEqual(await setAdminActive(999_999, false, mike), { ok: false, reason: 'unknown-admin' });
  assert.deepEqual(await resetAdminPassword(999_999, mike), { ok: false, reason: 'unknown-admin' });
});

test('resetAdminPassword bumps token_version and audits under the resetting owner', async (t) => {
  if (!dbAvailable) return t.skip();
  const jane = await seedAdmin(pool, { username: 'jane', name: 'Jane Smith', role: 'manager' });
  const before = await getAdmin(jane.id);

  const reset = await resetAdminPassword(jane.id, mike);
  assert.ok(reset.ok);
  assert.notEqual(reset.tempPassword, jane.password);
  assert.equal((await getAdmin(jane.id))?.tokenVersion, before!.tokenVersion + 1);
  // Attributed to the owner who did it, not to the account it happened to (seedAdmin creates
  // via the CLI path, so its own create-admin row is unattributed).
  assert.deepEqual(await auditFor(mike.id), ['reset-admin-password']);
});

test('changeOwnPassword requires the current password and enforces a length floor', async (t) => {
  if (!dbAvailable) return t.skip();
  assert.deepEqual(await changeOwnPassword(mike.id, 'not it', 'a long enough password'), {
    ok: false,
    reason: 'wrong-current',
  });
  // Length is checked first, so a weak new password is refused without touching the account.
  assert.deepEqual(await changeOwnPassword(mike.id, mike.password, 'short'), {
    ok: false,
    reason: 'weak-password',
  });
  assert.deepEqual(await changeOwnPassword(999_999, 'x', 'a long enough password'), {
    ok: false,
    reason: 'unknown-admin',
  });
  assert.equal((await getAdmin(mike.id))?.tokenVersion, 1);

  const changed = await changeOwnPassword(mike.id, mike.password, 'a long enough password');
  assert.deepEqual(changed, { ok: true, tokenVersion: 2 });
  assert.equal((await authenticateAdmin('mike', 'a long enough password')).ok, true);
  assert.equal((await authenticateAdmin('mike', mike.password)).ok, false);
});

test('listAdmins shows deactivated accounts too, active first', async (t) => {
  if (!dbAvailable) return t.skip();
  const jane = await seedAdmin(pool, { username: 'jane', name: 'Jane Smith', role: 'manager' });
  await seedAdmin(pool, { username: 'zoe', name: 'Zoe Ray', role: 'manager' });
  await setAdminActive(jane.id, false, mike);

  const list = await listAdmins();
  assert.deepEqual(
    list.map((a) => [a.username, a.role, a.active]),
    [
      ['mike', 'owner', true],
      ['zoe', 'manager', true],
      ['jane', 'manager', false],
    ]
  );
  // The row is never deleted — admin_actions points at it, and §31 forbids erasing history.
  assert.equal(list.length, 3);
});
