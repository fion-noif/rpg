// Integration tests for the worker credential lifecycle, against a real Postgres database
// (the "test" script in package.json points DATABASE_URL at a separate racing_test
// database). If that database isn't reachable, every case here is skipped rather than
// failed — see the `before` hook — so `npm test` still passes with no Postgres.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db';
import { issueToken, resolveToken, revokeEventTokens, workerByToken } from './workers';
import { applySchema, resetSchema, seedFixtures, type Fixtures } from './test-helpers';

let dbAvailable = true;
let fx: Fixtures;

before(async () => {
  try {
    await pool.query('SELECT 1');
    await applySchema(pool);
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `\nSkipping src/workers.db.test.ts — no reachable test database (${(err as Error).message}).\n` +
        'Run `npm run db:up`, then `docker compose exec db psql -U racing -c "CREATE DATABASE racing_test"`.\n'
    );
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await resetSchema(pool);
  fx = await seedFixtures(pool);
});

after(async () => {
  await pool.end();
});

test('issueToken returns a plaintext token that resolves to the worker session', async (t) => {
  if (!dbAvailable) return t.skip();
  const token = await issueToken(fx.workerAId);

  const session = await workerByToken(token);
  assert.ok(session);
  assert.equal(session.id, fx.workerAId);
  assert.equal(session.staff_id, fx.staffAId);
  assert.equal(session.event_id, fx.eventId);

  // The plaintext is never persisted — only its hash.
  const { rows } = await pool.query('SELECT token_hash FROM workers WHERE id = $1', [fx.workerAId]);
  assert.notEqual(rows[0].token_hash, token);
});

test('issuing a new token invalidates the previous one', async (t) => {
  if (!dbAvailable) return t.skip();
  const first = await issueToken(fx.workerAId);
  const second = await issueToken(fx.workerAId);

  assert.equal(await workerByToken(first), undefined);
  assert.ok(await workerByToken(second));
});

test('revokeEventTokens destroys every worker credential for the event', async (t) => {
  if (!dbAvailable) return t.skip();
  const tokenA = await issueToken(fx.workerAId);
  const tokenB = await issueToken(fx.workerBId);

  const revoked = await revokeEventTokens(fx.eventId);
  assert.equal(revoked, 2);

  assert.equal(await workerByToken(tokenA), undefined);
  assert.equal(await workerByToken(tokenB), undefined);

  // Revoked means deleted, not flagged: the hash is gone, so the link cannot be honoured
  // even if the revocation check were ever forgotten (design doc §8).
  const { rows } = await pool.query(
    'SELECT token_hash, token_revoked_at FROM workers WHERE event_id = $1 ORDER BY id',
    [fx.eventId]
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.token_hash, null);
    assert.notEqual(row.token_revoked_at, null);
  }
});

test('revoking twice is a no-op and skips the synthetic admin worker', async (t) => {
  if (!dbAvailable) return t.skip();
  await issueToken(fx.workerAId);
  await pool.query(
    `WITH s AS (INSERT INTO staff (name) VALUES ('Manager') RETURNING id)
     INSERT INTO workers (event_id, staff_id, name, is_admin)
     SELECT $1, s.id, 'Manager', TRUE FROM s`,
    [fx.eventId]
  );

  assert.equal(await revokeEventTokens(fx.eventId), 2);
  assert.equal(await revokeEventTokens(fx.eventId), 0);

  const { rows } = await pool.query(
    'SELECT token_revoked_at FROM workers WHERE event_id = $1 AND is_admin',
    [fx.eventId]
  );
  assert.equal(rows[0].token_revoked_at, null); // never had a credential to revoke
});

test('re-issuing after a revoke clears token_revoked_at and works again', async (t) => {
  if (!dbAvailable) return t.skip();
  await issueToken(fx.workerAId);
  await revokeEventTokens(fx.eventId);

  const fresh = await issueToken(fx.workerAId);
  const session = await workerByToken(fresh);
  assert.ok(session);
  assert.equal(session.id, fx.workerAId);

  const { rows } = await pool.query('SELECT token_revoked_at FROM workers WHERE id = $1', [fx.workerAId]);
  assert.equal(rows[0].token_revoked_at, null);
});

// ---------------------------------------------------------------------------
// Expiry (M4). The fixture event runs today, so its tokens start out live; each case moves
// the event's dates rather than the clock, which is the same thing from the token's point of
// view and does not require faking `now()`.
// ---------------------------------------------------------------------------

/** Moves the fixture event's dates so it ended `daysAgo` days ago. */
async function eventEnded(daysAgo: number): Promise<void> {
  await pool.query(
    `UPDATE events SET start_date = CURRENT_DATE - $2::int, end_date = CURRENT_DATE - $2::int
     WHERE id = $1`,
    [fx.eventId, daysAgo]
  );
}

test('a token is live during the event and for the whole day after it ends', async (t) => {
  if (!dbAvailable) return t.skip();
  const token = await issueToken(fx.workerAId);

  // Mid-weekend.
  await pool.query(
    `UPDATE events SET start_date = CURRENT_DATE - 1, end_date = CURRENT_DATE + 1 WHERE id = $1`,
    [fx.eventId]
  );
  assert.equal((await resolveToken(token)).ok, true, 'live during the event');

  // The last day of the event: a worker is still packing up.
  await eventEnded(0);
  assert.equal((await resolveToken(token)).ok, true, 'live on the closing day');

  // The day after. The grace period is a *full* day, not until midnight of the closing day,
  // so nobody is cut off while the trailers are still being loaded.
  await eventEnded(1);
  assert.equal((await resolveToken(token)).ok, true, 'live the day after');
});

test('a token expires two days after the event ends, with a reason', async (t) => {
  if (!dbAvailable) return t.skip();
  const token = await issueToken(fx.workerAId);
  await eventEnded(2);

  assert.deepEqual(await resolveToken(token), { ok: false, reason: 'expired' });
  // The convenience wrapper the API routes use collapses it to "no session", as they only
  // ever answer 401.
  assert.equal(await workerByToken(token), undefined);
});

test('an expired event reports expired, but a garbage token still reports unknown', async (t) => {
  if (!dbAvailable) return t.skip();
  await issueToken(fx.workerAId);
  await eventEnded(30);

  // The distinction is the whole point: the login page tells one worker "ask your manager
  // for a new link" and the other "this link is wrong".
  assert.deepEqual(await resolveToken('not-a-real-token'), { ok: false, reason: 'unknown' });
  assert.deepEqual(await resolveToken(undefined), { ok: false, reason: 'unknown' });
});

test('rotating a link cannot outlive its event — the reason updateEventDates exists', async (t) => {
  if (!dbAvailable) return t.skip();
  await eventEnded(5);

  // A manager reaching for the usual remedy: issue a fresh link. It is born expired, because
  // expiry belongs to the event, not to the token (src/admin/events.ts updateEventDates).
  const fresh = await issueToken(fx.workerAId);
  assert.deepEqual(await resolveToken(fresh), { ok: false, reason: 'expired' });

  // Moving the end date is what actually restores access — and it restores it for every
  // worker at once, including the token minted before the extension.
  await pool.query('UPDATE events SET end_date = CURRENT_DATE WHERE id = $1', [fx.eventId]);
  assert.equal((await resolveToken(fresh)).ok, true);
});

test('resolveToken reports the expiry instant the session cookie is capped to', async (t) => {
  if (!dbAvailable) return t.skip();
  const token = await issueToken(fx.workerAId);
  await eventEnded(0);

  const resolution = await resolveToken(token);
  assert.ok(resolution.ok);
  // app/login/[token]/route.ts caps the cookie's maxAge at this, so a session can never
  // outlive the credential and turn into an unexplainable 401.
  const hoursOut = (resolution.expiresAt.getTime() - Date.now()) / 3_600_000;
  assert.ok(hoursOut > 0 && hoursOut <= 48, `expected within 48h, got ${hoursOut}`);
});

test('a closed event reports unknown, not expired: closing destroys the hash', async (t) => {
  if (!dbAvailable) return t.skip();
  const token = await issueToken(fx.workerAId);
  await revokeEventTokens(fx.eventId);
  await pool.query('UPDATE events SET active = FALSE, closed_at = now() WHERE id = $1', [fx.eventId]);

  // Why 'unknown' and not a third 'closed' reason: there is no hash left to match, so the
  // token is indistinguishable from one that never existed. Saying "expired" here would be
  // a guess.
  assert.deepEqual(await resolveToken(token), { ok: false, reason: 'unknown' });
});
