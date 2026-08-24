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
  language: 'en' | 'es';
  event_id: number;
  event_code: string;
  event_name: string;
}

export async function workerByToken(token: string | undefined): Promise<WorkerSession | undefined> {
  if (!token) return undefined;
  const rows = await q<WorkerSession>(
    `SELECT w.id, w.name, w.language, w.event_id, e.code AS event_code, e.name AS event_name
     FROM workers w JOIN events e ON e.id = w.event_id
     WHERE w.token_hash = $1 AND e.active`,
    [hashToken(token)]
  );
  return rows[0];
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
