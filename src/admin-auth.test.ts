import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADMIN_COOKIE,
  ADMIN_TTL_MS,
  adminCookieOptions,
  isSecureBaseUrl,
  matchesAdminSecret,
  mintAdminCookie,
  recordAttempt,
  resetThrottle,
  safeEqual,
  verifyAdminCookie,
} from './admin-auth';
import { generateTempPassword, hashPassword, verifyPassword } from './admin-password';
import { config } from './config';

const SECRET = 'correct horse battery staple';
const OTHER = 'another secret entirely';
const WHO = { adminId: 7, tokenVersion: 3 };

// matchesAdminSecret reads config.adminSecret. Pin it here rather than depending on a
// local .env, so these tests behave the same on a fresh clone and in CI.
const configured = config as { adminSecret: string | null };
configured.adminSecret = SECRET;

test('cookie name is stable — changing it silently logs everyone out', () => {
  assert.equal(ADMIN_COOKIE, 'rw_admin');
});

test('safeEqual is true for equal strings and false otherwise, including unequal lengths', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  // Hashing both sides makes a length mismatch a plain false rather than a throw.
  assert.equal(safeEqual('abc', 'abcdefghijklmnop'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('', 'x'), false);
});

// ---------------------------------------------------------------------------
// The v2 cookie: it names a person
// ---------------------------------------------------------------------------

test('mint/verify round-trip returns the identity claims', () => {
  const now = 1_700_000_000_000;
  const cookie = mintAdminCookie(SECRET, WHO, now);
  assert.match(cookie, /^v2\.7\.3\.\d+\.[0-9a-f]{64}$/);
  assert.deepEqual(verifyAdminCookie(cookie, SECRET, now), {
    adminId: 7,
    tokenVersion: 3,
    expiresAt: now + ADMIN_TTL_MS,
  });
  assert.ok(verifyAdminCookie(cookie, SECRET, now + ADMIN_TTL_MS - 1));
});

test('an expired cookie is rejected', () => {
  const now = 1_700_000_000_000;
  const cookie = mintAdminCookie(SECRET, WHO, now);
  assert.equal(verifyAdminCookie(cookie, SECRET, now + ADMIN_TTL_MS), null);
  assert.equal(verifyAdminCookie(cookie, SECRET, now + ADMIN_TTL_MS + 1), null);
});

test('a tampered signature or extended expiry is rejected', () => {
  const now = 1_700_000_000_000;
  const cookie = mintAdminCookie(SECRET, WHO, now);
  const [v, id, ver, expiry, mac] = cookie.split('.');

  // flipped last hex digit of the MAC
  const flipped = mac.slice(0, -1) + (mac.endsWith('a') ? 'b' : 'a');
  assert.equal(verifyAdminCookie(`${v}.${id}.${ver}.${expiry}.${flipped}`, SECRET, now), null);

  // expiry pushed a year out, MAC kept — the expiry is inside the signed payload
  const farFuture = String(now + 365 * 24 * 60 * 60 * 1000);
  assert.equal(verifyAdminCookie(`${v}.${id}.${ver}.${farFuture}.${mac}`, SECRET, now), null);
});

test('the admin id is inside the signature, so a cookie cannot be re-pointed', () => {
  const now = 1_700_000_000_000;
  const [v, , ver, expiry, mac] = mintAdminCookie(SECRET, WHO, now).split('.');
  // Swapping admin 7 for admin 1 — the whole attack this test exists for.
  assert.equal(verifyAdminCookie(`${v}.1.${ver}.${expiry}.${mac}`, SECRET, now), null);
});

test('the token version is inside the signature too', () => {
  const now = 1_700_000_000_000;
  const [v, id, , expiry, mac] = mintAdminCookie(SECRET, WHO, now).split('.');
  // Otherwise a revoked session could be resurrected by editing one digit.
  assert.equal(verifyAdminCookie(`${v}.${id}.99.${expiry}.${mac}`, SECRET, now), null);
});

test('a wrong version prefix is rejected, including a leftover v1 cookie', () => {
  const now = 1_700_000_000_000;
  const [, id, ver, expiry, mac] = mintAdminCookie(SECRET, WHO, now).split('.');
  assert.equal(verifyAdminCookie(`v3.${id}.${ver}.${expiry}.${mac}`, SECRET, now), null);
  // The pre-M3 shape: anonymous, three parts. It must not resolve to anyone.
  assert.equal(verifyAdminCookie(`v1.${expiry}.${mac}`, SECRET, now), null);
});

test('malformed cookie values are rejected, not thrown on', () => {
  for (const bad of [
    '',
    'garbage',
    'v2.7.3',
    'v2.7.3.123',
    'v2.7.3.123.abc.def',
    'v2.7.3.notanumber.abcd',
    'v2.notanumber.3.123.abcd',
    'v2.7.notanumber.123.abcd',
    'v2.-7.3.123.abcd',
  ]) {
    assert.equal(verifyAdminCookie(bad, SECRET), null, `expected reject: ${JSON.stringify(bad)}`);
  }
});

test('verify fails closed when the secret is null, undefined, or empty', () => {
  const cookie = mintAdminCookie(SECRET, WHO);
  assert.equal(verifyAdminCookie(cookie, null), null);
  assert.equal(verifyAdminCookie(cookie, undefined), null);
  assert.equal(verifyAdminCookie(cookie, ''), null);
  assert.equal(verifyAdminCookie(undefined, SECRET), null);
});

test('rotating ADMIN_SECRET invalidates every outstanding cookie', () => {
  // Still the blunt, everyone-out lever; per-admin revocation is token_version.
  const cookie = mintAdminCookie(SECRET, WHO);
  assert.ok(verifyAdminCookie(cookie, SECRET));
  assert.equal(verifyAdminCookie(cookie, OTHER), null);
});

test('matchesAdminSecret accepts only the configured secret and fails closed when unset', () => {
  assert.equal(matchesAdminSecret(SECRET), true);
  assert.equal(matchesAdminSecret('nope'), false);
  assert.equal(matchesAdminSecret(''), false);
  assert.equal(matchesAdminSecret(null), false);
  try {
    configured.adminSecret = null;
    // An unset secret must not be matchable by an empty query param.
    assert.equal(matchesAdminSecret(''), false);
    assert.equal(matchesAdminSecret('anything'), false);
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
// Password hashing
// ---------------------------------------------------------------------------

test('hashPassword produces a scrypt$salt$hash that verifies', () => {
  const stored = hashPassword('a real password');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(verifyPassword('a real password', stored), true);
  assert.equal(verifyPassword('a real passwore', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('the same password hashes differently every time (a fresh salt)', () => {
  // Otherwise two managers who pick the same password are visibly identical in the table.
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('same', a), true);
  assert.equal(verifyPassword('same', b), true);
});

test('verifyPassword fails closed on a null, empty or malformed stored hash', () => {
  for (const bad of [
    null,
    undefined,
    '',
    'garbage',
    'scrypt$deadbeef',
    'scrypt$deadbeef$cafe$extra',
    // wrong scheme — a bcrypt hash pasted in by hand must not be treated as a match
    'bcrypt$deadbeef$cafebabe',
    // non-hex
    'scrypt$zzzz$cafebabe',
    // right shape, wrong key length
    'scrypt$deadbeef$cafebabe',
    // empty salt: scryptSync throws, and a throw must not become a 500
    'scrypt$$' + 'a'.repeat(64),
  ]) {
    assert.equal(verifyPassword('anything', bad as string | null), false, `expected reject: ${bad}`);
  }
});

test('generateTempPassword is 12 unambiguous characters and never repeats', () => {
  const a = generateTempPassword();
  assert.equal(a.length, 12);
  // No 0/O/1/l/I: these get read off a screen and typed into a phone.
  assert.match(a, /^[a-zA-Z2-9]+$/);
  assert.doesNotMatch(a, /[01lIO]/);
  const seen = new Set(Array.from({ length: 50 }, () => generateTempPassword()));
  assert.equal(seen.size, 50);
  assert.equal(generateTempPassword(20).length, 20);
});

// ---------------------------------------------------------------------------
// Safety net: we deliberately have no middleware.ts (per-route checks are the
// house style), so nothing stops someone adding an unguarded admin surface.
// This walks the filesystem instead.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, '..');
const GUARDS = [
  'checkAdmin',
  'checkAdminPage',
  'checkAdminRequest',
  'requireAdmin',
  'requireAdminIdentity',
  'requireAdminPage',
  'requireAdminOwnerPage',
];

// Two exemptions, both for the same reason — they are the surfaces you use when you are *not*
// signed in, so requiring a session would make them useless:
//   - logout: clearing your own cookie needs no authorization, and refusing to sign out an
//     already-expired session would be a worse experience for no security gain.
//   - login: it is the thing that mints the session.
// Every other admin file must reference a guard.
const EXEMPT = new Set(['app/api/admin/logout/route.ts', 'app/api/admin/login/route.ts']);

function walk(dir: string, match: (name: string) => boolean): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found = found.concat(walk(full, match));
    else if (match(entry)) found.push(full);
  }
  return found;
}

test('every admin page, admin API route, and admin Server Action file references an auth guard', () => {
  const files = [
    // actions.ts too: a Server Action is a POST endpoint reachable by anyone who learns its
    // id, so it needs the same guard as the page that renders its form.
    ...walk(join(REPO_ROOT, 'app/admin'), (n) => n === 'page.tsx' || n === 'actions.ts'),
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

// The companion assertion: a mutating route must require an *identity*, not a bearer secret.
// `requireAdmin` (which accepts `?secret=`) is allowed on exactly two read/script endpoints.
test('only the export and sync endpoints accept ?secret=', () => {
  const BEARER_OK = new Set(['app/api/admin/export/route.ts', 'app/api/admin/sync/route.ts']);
  const routes = walk(join(REPO_ROOT, 'app/api/admin'), (n) => n === 'route.ts').map((f) =>
    f.slice(REPO_ROOT.length + 1)
  );
  assert.ok(routes.length >= 5, `expected to find admin routes, found ${routes.length}`);

  for (const rel of routes) {
    const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
    // `requireAdminIdentity` contains `requireAdmin`, so match the import, not a substring.
    const bearer = /\brequireAdmin\b(?!Identity)/.test(source);
    if (BEARER_OK.has(rel)) continue;
    assert.equal(
      bearer,
      false,
      `${rel} uses requireAdmin (which accepts ?secret=) — a mutation needs requireAdminIdentity`
    );
  }
});
