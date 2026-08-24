import { createHash, randomBytes } from 'node:crypto';
import { q } from './db';

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

export async function workerByToken(token: string | undefined): Promise<WorkerSession | undefined> {
  if (!token) return undefined;
  // `token_hash IS NOT NULL` matters now that the column is nullable: revoked credentials
  // are NULLed rather than flagged, and the synthetic per-event manager worker never has
  // one, so neither must ever be reachable by hashing an attacker-supplied token.
  const rows = await q<WorkerSession>(
    `SELECT w.id, w.name, w.staff_id, w.language, w.event_id, e.code AS event_code, e.name AS event_name
     FROM workers w JOIN events e ON e.id = w.event_id
     WHERE w.token_hash = $1 AND w.token_hash IS NOT NULL AND e.active`,
    [hashToken(token)]
  );
  return rows[0];
}

/**
 * Mints a fresh magic-link token for a worker, storing only its hash and clearing any
 * previous revocation. Returns the plaintext, which is the one and only time it exists —
 * losing it means rotating again.
 */
export async function issueToken(workerId: number): Promise<string> {
  const token = newToken();
  await q('UPDATE workers SET token_hash = $1, token_revoked_at = NULL WHERE id = $2', [
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
export async function revokeEventTokens(eventId: number): Promise<number> {
  const rows = await q<{ id: number }>(
    `UPDATE workers SET token_hash = NULL, token_revoked_at = now()
     WHERE event_id = $1 AND NOT is_admin AND token_hash IS NOT NULL
     RETURNING id`,
    [eventId]
  );
  return rows.length;
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
