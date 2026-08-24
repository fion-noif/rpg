// Integration tests for the worker credential lifecycle, against a real Postgres database
// (the "test" script in package.json points DATABASE_URL at a separate racing_test
// database). If that database isn't reachable, every case here is skipped rather than
// failed — see the `before` hook — so `npm test` still passes with no Postgres.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './db';
import { issueToken, revokeEventTokens, workerByToken } from './workers';
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
