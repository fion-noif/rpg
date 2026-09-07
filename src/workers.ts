import { createHash, randomBytes } from 'node:crypto';
import { q, pool } from './db';
import { config } from './config';

/**
 * The subset of `pg.Pool` / `pg.PoolClient` these helpers need. Taking it as a parameter
 * lets a caller enlist them in an open transaction (closing an event revokes tokens in the
 * same tx that stamps `closed_at`) without every function growing a second variant.
 */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export const SESSION_COOKIE = 'rw_session';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(24).toString('hex');
}

export interface WorkerSession {
  id: number;
  name: string;
  staff_id: number;
  language: 'en' | 'es';
  event_id: number;
  event_code: string;
  event_name: string;
}

/**
 * Why a token did not resolve, so the one screen a locked-out worker is looking at can say
 * something true (M4). `expired` is deliberately distinguishable from `unknown` *only* on
 * the login page: it tells whoever holds the token that it was once real, which is a small
 * disclosure worth making to a mechanic whose link died overnight and worth nothing to the
 * API routes, which keep answering a flat 401 either way.
 */
export type TokenResolution =
  | { ok: true; worker: WorkerSession; expiresAt: Date }
  | { ok: false; reason: 'unknown' | 'expired' };

/**
 * The single token primitive: matches the hash, then decides whether the weekend it belongs
 * to is still live.
 *
 * Expiry is *derived* from `events.end_date` on every request rather than stamped on the
 * token, so a manager who pushes a long weekend's end date back revives every worker's link
 * at once — and, conversely, rotating a link can never smuggle a credential past the end of
 * its event. The cutoff is midnight at the *end* of the day after `end_date`, in
 * `config.eventTimeZone`: a link works for the whole day after the weekend finishes, so
 * nobody is cut off while the trailers are still being loaded. It is computed in SQL so the
 * database's clock is the only clock, matching every other `now()` in the app.
 */
export async function resolveToken(token: string | undefined): Promise<TokenResolution> {
  if (!token) return { ok: false, reason: 'unknown' };
  // `token_hash IS NOT NULL` matters now that the column is nullable: revoked credentials
  // are NULLed rather than flagged, and the synthetic per-event manager worker never has
  // one, so neither must ever be reachable by hashing an attacker-supplied token.
  //
  // `e.active` stays in the WHERE rather than becoming a third reason: closing an event
  // destroys the hashes in the same transaction (`revokeEventTokens`), so a closed event is
  // already unreachable by hash and a separate 'closed' verdict would be dead code.
  const rows = await q<WorkerSession & { expires_at: string; expired: boolean }>(
    `SELECT w.id, w.name, w.staff_id, w.language, w.event_id,
            e.code AS event_code, e.name AS event_name,
            ((e.end_date + 2)::timestamp AT TIME ZONE $2) AS expires_at,
            now() >= ((e.end_date + 2)::timestamp AT TIME ZONE $2) AS expired
     FROM workers w JOIN events e ON e.id = w.event_id
     WHERE w.token_hash = $1 AND w.token_hash IS NOT NULL AND e.active`,
    [hashToken(token), config.eventTimeZone]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.expired) return { ok: false, reason: 'expired' };
  const { expires_at, expired, ...worker } = row;
  return { ok: true, worker, expiresAt: new Date(expires_at) };
}

/**
 * Session lookup for callers that only need "is this a worker, yes or no" — the two API
 * routes, whose answer to every failure is the same 401. Kept as a wrapper over
 * `resolveToken` rather than a second query so there is one definition of a live token.
 */
export async function workerByToken(token: string | undefined): Promise<WorkerSession | undefined> {
  const resolution = await resolveToken(token);
  return resolution.ok ? resolution.worker : undefined;
}

/**
 * Mints a fresh magic-link token for a worker, storing only its hash and clearing any
 * previous revocation. Returns the plaintext, which is the one and only time it exists —
 * losing it means rotating again.
 */
export async function issueToken(workerId: number, client: Queryable = pool): Promise<string> {
  const token = newToken();
  await client.query('UPDATE workers SET token_hash = $1, token_revoked_at = NULL WHERE id = $2', [
    hashToken(token),
    workerId,
  ]);
  return token;
}

/**
 * Destroys every worker credential for an event (design doc §8 least privilege): closing a
 * weekend must make the links *gone*, not merely ignored, so the hash is dropped and the
 * revocation stamped. The synthetic admin worker is skipped — it has no token to begin
 * with. Returns the number of credentials destroyed.
 */
export async function revokeEventTokens(eventId: number, client: Queryable = pool): Promise<number> {
  const res = await client.query(
    `UPDATE workers SET token_hash = NULL, token_revoked_at = now()
     WHERE event_id = $1 AND NOT is_admin AND token_hash IS NOT NULL
     RETURNING id`,
    [eventId]
  );
  return res.rows.length;
}

export interface AssignedCustomer {
  qbo_id: string;
  display_name: string;
}

export async function assignmentsFor(workerId: number): Promise<AssignedCustomer[]> {
  return q<AssignedCustomer>(
    `SELECT c.qbo_id, c.display_name
     FROM assignments a JOIN customers c ON c.qbo_id = a.customer_qbo_id
     WHERE a.worker_id = $1 AND c.active
     ORDER BY c.display_name`,
    [workerId]
  );
}
