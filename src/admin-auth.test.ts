import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADMIN_COOKIE,
  ADMIN_TTL_MS,
  adminCookieOptions,
  checkAdmin,
  isSecureBaseUrl,
  mintAdminCookie,
  recordAttempt,
  resetThrottle,
  safeEqual,
  verifyAdminCookie,
} from './admin-auth';
import { config } from './config';

const SECRET = 'correct horse battery staple';
const OTHER = 'another secret entirely';

// checkAdmin reads config.adminSecret. Pin it here rather than depending on a
// local .env, so these tests behave the same on a fresh clone and in CI.
const configured = config as { adminSecret: string | null };
configured.adminSecret = SECRET;

test('cookie name is stable — changing it silently logs everyone out', () => {
  assert.equal(ADMIN_COOKIE, 'rw_admin');
});

test('safeEqual is true for equal strings and false otherwise, including unequal lengths', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  // The old isAuthorized threw here; hashing both sides makes it a plain false.
  assert.equal(safeEqual('abc', 'abcdefghijklmnop'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('', 'x'), false);
});

test('mint/verify round-trip', () => {
  const now = 1_700_000_000_000;
  const cookie = mintAdminCookie(SECRET, now);
  assert.match(cookie, /^v1\.\d+\.[0-9a-f]{64}$/);
  assert.equal(verifyAdminCookie(cookie, SECRET, now), true);
  assert.equal(verifyAdminCookie(cookie, SECRET, now + ADMIN_TTL_MS - 1), true);
});

test('an expired cookie is rejected', () => {
  const now = 1_700_000_000_000;
  const cookie = mintAdminCookie(SECRET, now);
  assert.equal(verifyAdminCookie(cookie, SECRET, now + ADMIN_TTL_MS + 1), false);
});

test('a tampered signature or extended expiry is rejected', () => {
  const now = 1_700_000_000_000;
  const cookie = mintAdminCookie(SECRET, now);
  const [version, expiry, mac] = cookie.split('.');

  // flipped last hex digit of the MAC
  const flipped = mac.slice(0, -1) + (mac.endsWith('a') ? 'b' : 'a');
  assert.equal(verifyAdminCookie(`${version}.${expiry}.${flipped}`, SECRET, now), false);

  // expiry pushed a year out, MAC kept — the expiry is inside the signed payload
  const farFuture = String(now + 365 * 24 * 60 * 60 * 1000);
  assert.equal(verifyAdminCookie(`${version}.${farFuture}.${mac}`, SECRET, now), false);
});

test('a wrong version prefix is rejected even with a valid-looking shape', () => {
  const now = 1_700_000_000_000;
  const cookie = mintAdminCookie(SECRET, now);
  const [, expiry, mac] = cookie.split('.');
  assert.equal(verifyAdminCookie(`v2.${expiry}.${mac}`, SECRET, now), false);
});

test('malformed cookie values are rejected, not thrown on', () => {
  for (const bad of ['', 'garbage', 'v1.123', 'v1.123.abc.def', 'v1.notanumber.abcd']) {
    assert.equal(verifyAdminCookie(bad, SECRET), false, `expected reject: ${JSON.stringify(bad)}`);
  }
});

test('verify fails closed when the secret is null, undefined, or empty', () => {
  const cookie = mintAdminCookie(SECRET);
  assert.equal(verifyAdminCookie(cookie, null), false);
  assert.equal(verifyAdminCookie(cookie, undefined), false);
  assert.equal(verifyAdminCookie(cookie, ''), false);
  assert.equal(verifyAdminCookie(undefined, SECRET), false);
});

test('rotating ADMIN_SECRET invalidates outstanding cookies', () => {
  const cookie = mintAdminCookie(SECRET);
  assert.equal(verifyAdminCookie(cookie, SECRET), true);
  assert.equal(verifyAdminCookie(cookie, OTHER), false);
});

test('checkAdmin accepts a valid cookie and reports how', () => {
  assert.deepEqual(checkAdmin({ cookie: mintAdminCookie(SECRET) }), { ok: true, via: 'cookie' });
});

test('checkAdmin accepts ?secret= only when allowQuerySecret is set', () => {
  const secret = SECRET;
  assert.deepEqual(checkAdmin({ secret }), { ok: true, via: 'query' });
  assert.deepEqual(checkAdmin({ secret, allowQuerySecret: true }), { ok: true, via: 'query' });
  // Pages pass false: a secret in a page URL leaks via history/Referer.
  assert.deepEqual(checkAdmin({ secret, allowQuerySecret: false }), {
    ok: false,
    reason: 'unauthenticated',
  });
});

test('checkAdmin rejects a wrong secret and an empty secret', () => {
  assert.deepEqual(checkAdmin({ secret: 'nope' }), { ok: false, reason: 'unauthenticated' });
  assert.deepEqual(checkAdmin({ secret: '' }), { ok: false, reason: 'unauthenticated' });
  assert.deepEqual(checkAdmin({}), { ok: false, reason: 'unauthenticated' });
});

test('checkAdmin reports "unconfigured" when ADMIN_SECRET is unset', () => {
  try {
    configured.adminSecret = null;
    // Fails closed: an unset secret must not be matchable by an empty query param.
    assert.deepEqual(checkAdmin({ secret: '' }), { ok: false, reason: 'unconfigured' });
    assert.deepEqual(checkAdmin({ cookie: mintAdminCookie(SECRET) }), {
      ok: false,
      reason: 'unconfigured',
    });
  } finally {
    configured.adminSecret = SECRET;
  }
});

test('the secure flag follows appBaseUrl', () => {
  assert.equal(isSecureBaseUrl('https://parts.example.com'), true);
  assert.equal(isSecureBaseUrl('http://localhost:3000'), false);
  const opts = adminCookieOptions();
  assert.equal(opts.secure, isSecureBaseUrl(config.appBaseUrl));
  assert.equal(opts.httpOnly, true);
  assert.equal(opts.sameSite, 'strict');
  assert.equal(opts.path, '/');
  assert.equal(opts.maxAge, ADMIN_TTL_MS / 1000);
});

test('throttle allows 10 attempts per key then rejects, and resets after the window', () => {
  resetThrottle();
  const now = 1_700_000_000_000;
  for (let i = 1; i <= 10; i++) {
    assert.equal(recordAttempt('1.2.3.4', now + i), true, `attempt ${i} should be allowed`);
  }
  assert.equal(recordAttempt('1.2.3.4', now + 11), false);

  // A different caller is unaffected.
  assert.equal(recordAttempt('5.6.7.8', now + 12), true);

  // Fixed window: 10 minutes later the counter starts over.
  assert.equal(recordAttempt('1.2.3.4', now + 10 * 60 * 1000 + 1), true);
  resetThrottle();
});

// ---------------------------------------------------------------------------
// Safety net: we deliberately have no middleware.ts (per-route checks are the
// house style), so nothing stops someone adding an unguarded admin surface.
// This walks the filesystem instead.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, '..');
const GUARDS = ['checkAdmin', 'checkAdminRequest', 'requireAdmin', 'requireAdminPage'];

// /api/admin/logout is the one exemption: clearing your own cookie needs no
// authorization. Every other admin file must reference a guard.
const EXEMPT = new Set(['app/api/admin/logout/route.ts']);

function walk(dir: string, match: (name: string) => boolean): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found = found.concat(walk(full, match));
    else if (match(entry)) found.push(full);
  }
  return found;
}

test('every admin page and admin API route references an auth guard', () => {
  const files = [
    ...walk(join(REPO_ROOT, 'app/admin'), (n) => n === 'page.tsx'),
    ...walk(join(REPO_ROOT, 'app/api/admin'), (n) => n === 'route.ts'),
  ].map((f) => f.slice(REPO_ROOT.length + 1));

  // Guards against the walk silently finding nothing (e.g. a moved directory).
  assert.ok(files.length >= 5, `expected to find admin files, found ${files.length}`);

  for (const rel of files) {
    if (EXEMPT.has(rel)) continue;
    const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
    assert.ok(
      GUARDS.some((g) => source.includes(g)),
      `${rel} does not reference any of ${GUARDS.join('/')} — unguarded admin surface?`
    );
  }
});
