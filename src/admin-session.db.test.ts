// Step 2 of admin auth against a real database: a signed cookie is not enough, the account
// behind it has to still be good. Same skip-if-unreachable contract as the other .db tests.
//
// These cases are the revocation story, and they are the reason there is a DB read on every
// admin request: deactivate or reset, and the existing cookie stops working on the next click
// rather than at expiry.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db';
import { mintAdminCookie } from './admin-auth';
import { checkAdmin, sessionForClaims } from './admin-session';
import {
  authenticateAdmin,
  changeOwnPassword,
  getAdmin,
  resetAdminPassword,
  setAdminActive,
} from './admin/admins';
import { applySchema, resetSchema, seedAdmin } from './test-helpers';
import { config } from './config';

const SECRET = 'test admin secret for the session layer';
// checkAdmin reads config.adminSecret; pin it so this behaves the same on a fresh clone.
const configured = config as { adminSecret: string | null };
configured.adminSecret = SECRET;

let dbAvailable = true;
let mike: { id: number; username: string; name: string; password: string };

before(async () => {
  try {
    await pool.query('SELECT 1');
    await applySchema(pool);
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `\nSkipping src/admin-session.db.test.ts — no reachable test database (${(err as Error).message}).\n` +
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

/** The cookie the app would have handed this admin at their current token_version. */
async function cookieFor(id: number): Promise<string> {
  const admin = await getAdmin(id);
  assert.ok(admin);
  return mintAdminCookie(SECRET, { adminId: id, tokenVersion: admin.tokenVersion });
}

test('a valid cookie resolves to the named admin', async (t) => {
  if (!dbAvailable) return t.skip();
  const check = await checkAdmin({ cookie: await cookieFor(mike.id) });
  assert.deepEqual(check, {
    ok: true,
    via: 'cookie',
    admin: { id: mike.id, username: 'mike', name: 'Mike Rolison', role: 'owner' },
  });
});

test('a cookie for an admin that does not exist is rejected', async (t) => {
  if (!dbAvailable) return t.skip();
  // Correctly signed, so this is exactly the case the signature check cannot catch.
  const cookie = mintAdminCookie(SECRET, { adminId: 999_999, tokenVersion: 1 });
  assert.deepEqual(await checkAdmin({ cookie }), { ok: false, reason: 'unauthenticated' });
});

test('deactivating an admin kills their outstanding cookie immediately', async (t) => {
  if (!dbAvailable) return t.skip();
  const jane = await seedAdmin(pool, { username: 'jane', name: 'Jane Smith', role: 'manager' });
  const cookie = await cookieFor(jane.id);
  assert.equal((await checkAdmin({ cookie })).ok, true);

  assert.deepEqual(await setAdminActive(jane.id, false, mike), { ok: true, active: false });
  assert.deepEqual(await checkAdmin({ cookie }), { ok: false, reason: 'unauthenticated' });

  // Reactivation does not resurrect the old cookie: token_version moved again.
  assert.deepEqual(await setAdminActive(jane.id, true, mike), { ok: true, active: true });
  assert.deepEqual(await checkAdmin({ cookie }), { ok: false, reason: 'unauthenticated' });
  assert.equal((await checkAdmin({ cookie: await cookieFor(jane.id) })).ok, true);
});

test('a token_version bump from a password change invalidates the old cookie only', async (t) => {
  if (!dbAvailable) return t.skip();
  const jane = await seedAdmin(pool, { username: 'jane', name: 'Jane Smith', role: 'manager' });
  const janeCookie = await cookieFor(jane.id);
  const mikeCookie = await cookieFor(mike.id);

  const changed = await changeOwnPassword(jane.id, jane.password, 'a longer new password');
  assert.equal(changed.ok, true);

  assert.deepEqual(await checkAdmin({ cookie: janeCookie }), { ok: false, reason: 'unauthenticated' });
  // Per-admin revocation, not a global logout — that is what ADMIN_SECRET rotation is for.
  assert.equal((await checkAdmin({ cookie: mikeCookie })).ok, true);
  // And the re-minted cookie (what the change-password action hands back) works.
  assert.ok(changed.ok);
  const reminted = mintAdminCookie(SECRET, { adminId: jane.id, tokenVersion: changed.tokenVersion });
  assert.equal((await checkAdmin({ cookie: reminted })).ok, true);
});

test('an owner password reset signs the target out', async (t) => {
  if (!dbAvailable) return t.skip();
  const jane = await seedAdmin(pool, { username: 'jane', name: 'Jane Smith', role: 'manager' });
  const cookie = await cookieFor(jane.id);
  const reset = await resetAdminPassword(jane.id, mike);
  assert.ok(reset.ok);
  assert.deepEqual(await checkAdmin({ cookie }), { ok: false, reason: 'unauthenticated' });
  // The new temp password is the only way back in.
  assert.equal((await authenticateAdmin('jane', reset.tempPassword)).ok, true);
  assert.equal((await authenticateAdmin('jane', jane.password)).ok, false);
});

test('sessionForClaims returns null for a stale version and never leaks the hash', async (t) => {
  if (!dbAvailable) return t.skip();
  const fresh = await sessionForClaims({ adminId: mike.id, tokenVersion: 1 });
  assert.deepEqual(fresh, {
    id: mike.id,
    username: 'mike',
    name: 'Mike Rolison',
    role: 'owner',
  });
  assert.equal(await sessionForClaims({ adminId: mike.id, tokenVersion: 2 }), null);
  assert.equal(await sessionForClaims({ adminId: mike.id, tokenVersion: 0 }), null);
});

test('?secret= is accepted only when the caller opts in, and never carries an identity', async (t) => {
  if (!dbAvailable) return t.skip();
  // The read/script path: authenticated, anonymous, and unusable for anything that writes.
  assert.deepEqual(await checkAdmin({ secret: SECRET, allowQuerySecret: true }), {
    ok: true,
    via: 'query',
  });
  // Default is off, because most surfaces mutate.
  assert.deepEqual(await checkAdmin({ secret: SECRET }), { ok: false, reason: 'unauthenticated' });
  assert.deepEqual(await checkAdmin({ secret: 'wrong', allowQuerySecret: true }), {
    ok: false,
    reason: 'unauthenticated',
  });
});

test('an unset ADMIN_SECRET reads as unconfigured, not as a wrong password', async (t) => {
  if (!dbAvailable) return t.skip();
  const cookie = await cookieFor(mike.id);
  try {
    configured.adminSecret = null;
    assert.deepEqual(await checkAdmin({ cookie }), { ok: false, reason: 'unconfigured' });
    assert.deepEqual(await checkAdmin({ secret: '', allowQuerySecret: true }), {
      ok: false,
      reason: 'unconfigured',
    });
  } finally {
    configured.adminSecret = SECRET;
  }
});

test('an expired cookie is rejected before the database is consulted', async (t) => {
  if (!dbAvailable) return t.skip();
  const long_ago = Date.now() - 48 * 60 * 60 * 1000;
  const cookie = mintAdminCookie(SECRET, { adminId: mike.id, tokenVersion: 1 }, long_ago);
  assert.deepEqual(await checkAdmin({ cookie }), { ok: false, reason: 'unauthenticated' });
});
