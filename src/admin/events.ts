// Event setup: the manager's side of a race weekend (plan §6).
//
// Everything here is a plain async function over `pg` so it is testable without an HTTP
// server (src/admin-events.db.test.ts); the pages and route handlers are thin controllers.
//
// House rules followed throughout:
//   - Failures the caller is expected to handle are returned as a discriminated union,
//     never thrown. Thrown errors mean a bug or a dead database.
//   - Every multi-statement write is one transaction (see `withTx`).
//   - Manager actions that change who can see or bill what are recorded in `admin_actions`
//     (§17 "edits logged" / §23 Rule 4).
import type pg from 'pg';
import { pool } from '../db';
import { hashToken, newToken, issueToken, revokeEventTokens } from '../workers';
import { config } from '../config';
import { normalizeLanguage, normalizeName } from './staff';
import type { AdminActor } from './admins';

/**
 * The event code flows into a 21-char QBO DocNumber and into a QBO query literal, so its
 * shape is constrained here, at the form, and by a CHECK on `events` (db/schema.sql). This
 * regex is the user-facing copy of that CHECK — keep the three in step.
 */
export const EVENT_CODE_RE = /^[A-Z0-9]{1,8}$/;

/**
 * One transaction per call, committed only if the operation succeeded. Because every
 * function here returns `{ok:false, …}` for the failures the caller must handle, "rejected"
 * and "nothing persisted" are the same condition — so the rollback lives here instead of
 * being repeated (and occasionally forgotten) at every guard.
 */
async function withTx<T extends { ok: boolean }>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

interface ActionLog {
  action: string;
  /** Who did it (M3, §23 Rule 4). Every caller of a logging mutation now takes a session. */
  admin: AdminActor;
  eventId?: number | null;
  customerQboId?: string | null;
  batchId?: number | null;
  detail?: Record<string, unknown>;
}

async function logAction(client: pg.PoolClient, entry: ActionLog): Promise<void> {
  await client.query(
    `INSERT INTO admin_actions (action, event_id, customer_qbo_id, batch_id, admin_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      entry.action,
      entry.eventId ?? null,
      entry.customerQboId ?? null,
      entry.batchId ?? null,
      entry.admin.id,
      // The name is denormalised into the detail as well as joinable via admin_id: a rename
      // must not silently rewrite what an old audit row says happened at the time.
      JSON.stringify({ ...(entry.detail ?? {}), by: entry.admin.name }),
    ]
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type CreateEventResult =
  | { ok: true; eventId: number }
  | { ok: false; reason: 'invalid-code' | 'invalid-name' | 'duplicate-code' };

/**
 * Codes are uppercased for the manager (typing `r8` is not an error worth reporting) but
 * otherwise validated strictly. A duplicate is a normal outcome — the manager forgot the
 * event already exists — so it comes back as a reason, not a Postgres unique violation.
 */
export async function createEvent(input: { code: string; name: string }): Promise<CreateEventResult> {
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (!EVENT_CODE_RE.test(code)) return { ok: false, reason: 'invalid-code' };
  const name = normalizeName(input.name);
  if (!name) return { ok: false, reason: 'invalid-name' };

  const res = await pool.query<{ id: number }>(
    `INSERT INTO events (code, name) VALUES ($1, $2)
     ON CONFLICT (code) DO NOTHING
     RETURNING id`,
    [code, name]
  );
  if (res.rows.length === 0) return { ok: false, reason: 'duplicate-code' };
  return { ok: true, eventId: res.rows[0].id };
}

export interface EventSummary {
  id: number;
  code: string;
  name: string;
  active: boolean;
  closed_at: string | null;
  created_at: string;
  customerCount: number;
  workerCount: number;
  /** Participating customers with no charge batch yet — still open for entry/review. */
  openCount: number;
  approvedCount: number;
  postedCount: number;
  failedCount: number;
}

/** Dashboard list, newest first. One query — the summary is a handful of scalar subqueries. */
export async function listEvents(): Promise<EventSummary[]> {
  return (
    await pool.query<EventSummary>(
      `SELECT e.id, e.code, e.name, e.active, e.closed_at, e.created_at,
              (SELECT count(*)::int FROM event_customers ec WHERE ec.event_id = e.id)
                AS "customerCount",
              (SELECT count(*)::int FROM workers w WHERE w.event_id = e.id AND NOT w.is_admin)
                AS "workerCount",
              (SELECT count(*)::int FROM event_customers ec
                WHERE ec.event_id = e.id AND NOT EXISTS (
                  SELECT 1 FROM charge_batches b
                  WHERE b.event_id = ec.event_id AND b.customer_qbo_id = ec.customer_qbo_id))
                AS "openCount",
              (SELECT count(*)::int FROM charge_batches b
                WHERE b.event_id = e.id AND b.status = 'APPROVED') AS "approvedCount",
              (SELECT count(*)::int FROM charge_batches b
                WHERE b.event_id = e.id AND b.status = 'POSTED') AS "postedCount",
              (SELECT count(*)::int FROM charge_batches b
                WHERE b.event_id = e.id AND b.status = 'POST_FAILED') AS "failedCount"
       FROM events e
       ORDER BY e.created_at DESC, e.id DESC`
    )
  ).rows;
}

export interface EventDetail {
  id: number;
  code: string;
  name: string;
  active: boolean;
  closed_at: string | null;
  created_at: string;
}

export async function getEvent(eventId: number): Promise<EventDetail | undefined> {
  const res = await pool.query<EventDetail>(
    'SELECT id, code, name, active, closed_at, created_at FROM events WHERE id = $1',
    [eventId]
  );
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// Participating customers (§21)
// ---------------------------------------------------------------------------

export interface EventCustomer {
  qboId: string;
  displayName: string;
  active: boolean;
  addedAt: string;
  /** Names of the workers assigned to this customer at this event, alphabetical. */
  workers: string[];
  /** null when nothing has been approved yet. */
  batchStatus: 'APPROVED' | 'POSTED' | 'POST_FAILED' | null;
  submissionCount: number;
}

export async function listCustomers(eventId: number): Promise<EventCustomer[]> {
  return (
    await pool.query<EventCustomer>(
      `SELECT ec.customer_qbo_id AS "qboId", c.display_name AS "displayName", c.active,
              ec.added_at AS "addedAt",
              COALESCE(asg.names, ARRAY[]::text[]) AS workers,
              b.status AS "batchStatus",
              (SELECT count(*)::int FROM submissions s
                WHERE s.event_id = ec.event_id AND s.customer_qbo_id = ec.customer_qbo_id)
                AS "submissionCount"
       FROM event_customers ec
       JOIN customers c ON c.qbo_id = ec.customer_qbo_id
       LEFT JOIN charge_batches b
              ON b.event_id = ec.event_id AND b.customer_qbo_id = ec.customer_qbo_id
       LEFT JOIN LATERAL (
         SELECT array_agg(w.name ORDER BY w.name) AS names
         FROM assignments a JOIN workers w ON w.id = a.worker_id
         WHERE a.customer_qbo_id = ec.customer_qbo_id AND w.event_id = ec.event_id
       ) asg ON TRUE
       WHERE ec.event_id = $1
       ORDER BY c.display_name`,
      [eventId]
    )
  ).rows;
}

export interface PickableCustomer {
  qboId: string;
  displayName: string;
}

/** Synced, active QuickBooks customers not yet on this event — the "add customer" select. */
export async function availableCustomers(eventId: number): Promise<PickableCustomer[]> {
  return (
    await pool.query<PickableCustomer>(
      `SELECT c.qbo_id AS "qboId", c.display_name AS "displayName"
       FROM customers c
       WHERE c.active
         AND NOT EXISTS (
           SELECT 1 FROM event_customers ec
           WHERE ec.event_id = $1 AND ec.customer_qbo_id = c.qbo_id)
       ORDER BY c.display_name`,
      [eventId]
    )
  ).rows;
}

export type AddCustomerResult =
  | { ok: true; added: boolean }
  | { ok: false; reason: 'unknown-event' | 'event-closed' | 'unknown-customer' };

export async function addCustomer(
  eventId: number,
  customerQboId: string,
  admin: AdminActor
): Promise<AddCustomerResult> {
  return withTx(async (client) => {
    const event = await lockEvent(client, eventId);
    if (!event) return { ok: false as const, reason: 'unknown-event' as const };
    if (event.closed_at) return { ok: false as const, reason: 'event-closed' as const };

    const customer = await client.query('SELECT 1 FROM customers WHERE qbo_id = $1', [customerQboId]);
    if (customer.rowCount === 0) return { ok: false as const, reason: 'unknown-customer' as const };

    const ins = await client.query(
      `INSERT INTO event_customers (event_id, customer_qbo_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING customer_qbo_id`,
      [eventId, customerQboId]
    );
    // Re-adding an already-participating customer is a no-op, not an error, and not worth
    // an audit row.
    if (ins.rows.length === 0) return { ok: true as const, added: false };

    await logAction(client, { action: 'add-customer', admin, eventId, customerQboId });
    return { ok: true as const, added: true };
  });
}

export type RemoveCustomerResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'unknown-event' | 'event-closed' | 'not-participating' | 'has-submissions' | 'has-batch';
    };

/**
 * Removal is only for correcting a mis-add. Once a worker has opened a tab or the customer
 * has been approved there is billing history hanging off the participation row, and dropping
 * it would orphan that history — refused rather than cascaded (§31 append-only).
 */
export async function removeCustomer(
  eventId: number,
  customerQboId: string,
  admin: AdminActor
): Promise<RemoveCustomerResult> {
  return withTx(async (client) => {
    const event = await lockEvent(client, eventId);
    if (!event) return { ok: false as const, reason: 'unknown-event' as const };
    if (event.closed_at) return { ok: false as const, reason: 'event-closed' as const };

    const participating = await client.query(
      'SELECT 1 FROM event_customers WHERE event_id = $1 AND customer_qbo_id = $2',
      [eventId, customerQboId]
    );
    if (participating.rowCount === 0) return { ok: false as const, reason: 'not-participating' as const };

    const subs = await client.query(
      'SELECT 1 FROM submissions WHERE event_id = $1 AND customer_qbo_id = $2 LIMIT 1',
      [eventId, customerQboId]
    );
    if (subs.rowCount) return { ok: false as const, reason: 'has-submissions' as const };

    const batch = await client.query(
      'SELECT 1 FROM charge_batches WHERE event_id = $1 AND customer_qbo_id = $2 LIMIT 1',
      [eventId, customerQboId]
    );
    if (batch.rowCount) return { ok: false as const, reason: 'has-batch' as const };

    // Assignments are scoped to a worker, not to participation, so they have to go too —
    // otherwise a worker keeps seeing a customer the event no longer includes.
    await client.query(
      `DELETE FROM assignments a
       USING workers w
       WHERE a.worker_id = w.id AND w.event_id = $1 AND a.customer_qbo_id = $2`,
      [eventId, customerQboId]
    );
    await client.query('DELETE FROM event_customers WHERE event_id = $1 AND customer_qbo_id = $2', [
      eventId,
      customerQboId,
    ]);
    await logAction(client, { action: 'remove-customer', admin, eventId, customerQboId });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Workers (per-event participation + credential)
// ---------------------------------------------------------------------------

export interface EventWorker {
  id: number;
  staffId: number;
  name: string;
  language: 'en' | 'es';
  /** False once the event is closed or the link was revoked — the link is gone, not stale. */
  hasToken: boolean;
  tokenRevokedAt: string | null;
  customers: string[];
  submissionCount: number;
}

export async function listWorkers(eventId: number): Promise<EventWorker[]> {
  return (
    await pool.query<EventWorker>(
      `SELECT w.id, w.staff_id AS "staffId", w.name, w.language,
              (w.token_hash IS NOT NULL) AS "hasToken",
              w.token_revoked_at AS "tokenRevokedAt",
              COALESCE(asg.ids, ARRAY[]::text[]) AS customers,
              (SELECT count(*)::int FROM submissions s WHERE s.worker_id = w.id) AS "submissionCount"
       FROM workers w
       LEFT JOIN LATERAL (
         SELECT array_agg(a.customer_qbo_id ORDER BY a.customer_qbo_id) AS ids
         FROM assignments a WHERE a.worker_id = w.id
       ) asg ON TRUE
       WHERE w.event_id = $1 AND NOT w.is_admin
       ORDER BY w.name, w.id`,
      [eventId]
    )
  ).rows;
}

export type AddWorkerInput =
  | { eventId: number; staffId: number }
  | { eventId: number; newStaff: { name: string; language?: 'en' | 'es' } };

export type AddWorkerResult =
  | {
      ok: true;
      workerId: number;
      staffId: number;
      name: string;
      /**
       * Present exactly once, on the call that created the participation row. A token is
       * stored only as a hash, so it can never be re-read — a manager who loses it must
       * rotate. `null` therefore means "already on the event; rotate to get a new link".
       */
      link: string | null;
    }
  | { ok: false; reason: 'unknown-event' | 'event-closed' | 'unknown-staff' | 'invalid-name' };

/**
 * Adds a person to an event, creating their staff identity first if this is a brand-new
 * person. The magic-link token is minted inside the same transaction as the participation
 * row so a crash can never leave a worker with no credential.
 *
 * Idempotent on (event_id, staff_id): a duplicate add returns the existing worker with
 * `link: null` rather than silently rotating the link out from under someone mid-weekend.
 */
export async function addWorkerToEvent(
  input: AddWorkerInput,
  admin: AdminActor
): Promise<AddWorkerResult> {
  return withTx(async (client) => {
    const event = await lockEvent(client, input.eventId);
    if (!event) return { ok: false as const, reason: 'unknown-event' as const };
    if (event.closed_at) return { ok: false as const, reason: 'event-closed' as const };

    let staffId: number;
    if ('staffId' in input) {
      const staff = await client.query('SELECT id FROM staff WHERE id = $1', [input.staffId]);
      if (staff.rowCount === 0) return { ok: false as const, reason: 'unknown-staff' as const };
      staffId = input.staffId;
    } else {
      const name = normalizeName(input.newStaff.name);
      if (!name) return { ok: false as const, reason: 'invalid-name' as const };
      const created = await client.query<{ id: number }>(
        'INSERT INTO staff (name, language) VALUES ($1, $2) RETURNING id',
        [name, normalizeLanguage(input.newStaff.language)]
      );
      staffId = created.rows[0].id;
    }

    // The event-time name and language are copied from staff, not joined: a person's tab
    // should read the way it read during the weekend even if they later change their name
    // or switch language for the next event.
    const token = newToken();
    const inserted = await client.query<{ id: number; name: string }>(
      `INSERT INTO workers (event_id, staff_id, name, language, token_hash)
       SELECT $1, s.id, s.name, s.language, $3 FROM staff s WHERE s.id = $2
       ON CONFLICT (event_id, staff_id) DO NOTHING
       RETURNING id, name`,
      [input.eventId, staffId, hashToken(token)]
    );

    if (inserted.rows.length === 0) {
      const existing = await client.query<{ id: number; name: string }>(
        'SELECT id, name FROM workers WHERE event_id = $1 AND staff_id = $2',
        [input.eventId, staffId]
      );
      return {
        ok: true as const,
        workerId: existing.rows[0].id,
        staffId,
        name: existing.rows[0].name,
        link: null,
      };
    }

    await logAction(client, {
      action: 'add-worker',
      admin,
      eventId: input.eventId,
      detail: { workerId: inserted.rows[0].id, staffId, name: inserted.rows[0].name },
    });
    return {
      ok: true as const,
      workerId: inserted.rows[0].id,
      staffId,
      name: inserted.rows[0].name,
      link: loginLink(token),
    };
  });
}

export function loginLink(token: string): string {
  return `${config.appBaseUrl}/login/${token}`;
}

export type RotateTokenResult =
  | { ok: true; link: string }
  | { ok: false; reason: 'unknown-worker' | 'event-closed' };

/**
 * Issues a replacement link and kills the old one (the hash is overwritten, so the previous
 * token stops resolving immediately). Used when a worker loses their link or a phone walks.
 */
export async function rotateWorkerToken(
  workerId: number,
  admin: AdminActor
): Promise<RotateTokenResult> {
  return withTx(async (client) => {
    const res = await client.query<{ closed_at: string | null }>(
      `SELECT e.closed_at FROM workers w JOIN events e ON e.id = w.event_id
       WHERE w.id = $1 AND NOT w.is_admin
       FOR UPDATE OF w`,
      [workerId]
    );
    if (res.rows.length === 0) return { ok: false as const, reason: 'unknown-worker' as const };
    if (res.rows[0].closed_at) return { ok: false as const, reason: 'event-closed' as const };

    const token = await issueToken(workerId, client);
    await logAction(client, { action: 'rotate-token', admin, detail: { workerId } });
    return { ok: true as const, link: loginLink(token) };
  });
}

export type RemoveWorkerResult =
  | { ok: true }
  | { ok: false; reason: 'unknown-worker' | 'event-closed' | 'has-submissions' };

/**
 * Undo for a mis-add. A worker who has recorded anything is kept forever: their submissions
 * reference them and §31 forbids destroying entry history. Rotate or close the event to kill
 * their access instead.
 */
export async function removeWorkerFromEvent(
  workerId: number,
  admin: AdminActor
): Promise<RemoveWorkerResult> {
  return withTx(async (client) => {
    const res = await client.query<{ event_id: number; name: string; closed_at: string | null }>(
      `SELECT w.event_id, w.name, e.closed_at FROM workers w JOIN events e ON e.id = w.event_id
       WHERE w.id = $1 AND NOT w.is_admin
       FOR UPDATE OF w`,
      [workerId]
    );
    if (res.rows.length === 0) return { ok: false as const, reason: 'unknown-worker' as const };
    const worker = res.rows[0];
    if (worker.closed_at) return { ok: false as const, reason: 'event-closed' as const };

    const subs = await client.query('SELECT 1 FROM submissions WHERE worker_id = $1 LIMIT 1', [workerId]);
    if (subs.rowCount) return { ok: false as const, reason: 'has-submissions' as const };

    await client.query('DELETE FROM assignments WHERE worker_id = $1', [workerId]);
    await client.query('DELETE FROM workers WHERE id = $1', [workerId]);
    await logAction(client, {
      action: 'remove-worker',
      admin,
      eventId: worker.event_id,
      detail: { workerId, name: worker.name },
    });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Assignments (worker ↔ customer)
// ---------------------------------------------------------------------------

export type AssignResult =
  | { ok: true }
  | { ok: false; reason: 'unknown-worker' | 'event-closed' | 'unknown-customer' };

/**
 * Assigning implies participation (§21): a worker can only be pointed at a customer the
 * event includes, so the participation row is created here in the same transaction rather
 * than making the manager remember the two-step.
 */
export async function assign(workerId: number, customerQboId: string): Promise<AssignResult> {
  return withTx(async (client) => {
    const res = await client.query<{ event_id: number; closed_at: string | null }>(
      `SELECT w.event_id, e.closed_at FROM workers w JOIN events e ON e.id = w.event_id
       WHERE w.id = $1 AND NOT w.is_admin
       FOR UPDATE OF w`,
      [workerId]
    );
    if (res.rows.length === 0) return { ok: false as const, reason: 'unknown-worker' as const };
    if (res.rows[0].closed_at) return { ok: false as const, reason: 'event-closed' as const };
    const eventId = res.rows[0].event_id;

    const customer = await client.query('SELECT 1 FROM customers WHERE qbo_id = $1', [customerQboId]);
    if (customer.rowCount === 0) return { ok: false as const, reason: 'unknown-customer' as const };

    await client.query(
      `INSERT INTO event_customers (event_id, customer_qbo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [eventId, customerQboId]
    );
    await client.query(
      `INSERT INTO assignments (worker_id, customer_qbo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [workerId, customerQboId]
    );
    return { ok: true as const };
  });
}

export type UnassignResult = { ok: true } | { ok: false; reason: 'unknown-worker' | 'event-closed' };

/**
 * Takes a customer off a worker's list. Participation and any tab the worker already opened
 * are left alone — this only changes what they can still write to (§8 least privilege).
 */
export async function unassign(workerId: number, customerQboId: string): Promise<UnassignResult> {
  return withTx(async (client) => {
    const res = await client.query<{ closed_at: string | null }>(
      `SELECT e.closed_at FROM workers w JOIN events e ON e.id = w.event_id
       WHERE w.id = $1 AND NOT w.is_admin
       FOR UPDATE OF w`,
      [workerId]
    );
    if (res.rows.length === 0) return { ok: false as const, reason: 'unknown-worker' as const };
    if (res.rows[0].closed_at) return { ok: false as const, reason: 'event-closed' as const };

    await client.query('DELETE FROM assignments WHERE worker_id = $1 AND customer_qbo_id = $2', [
      workerId,
      customerQboId,
    ]);
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Closing the event
// ---------------------------------------------------------------------------

export interface UnpostedCustomer {
  qboId: string;
  displayName: string;
  /** 'NOT_APPROVED' when there is no batch at all. */
  status: string;
}

export type CloseEventResult =
  | { ok: true; tokensRevoked: number }
  | { ok: false; reason: 'unknown-event' | 'already-closed' }
  | { ok: false; reason: 'unposted-customers'; customers: UnpostedCustomer[] };

/**
 * Ends the weekend, in one transaction: stamps `closed_at`, clears `active` (so the
 * read-only usage view and `workerByToken` stop matching it), and destroys every worker
 * credential (§8 — links must be *gone*, not merely ignored).
 *
 * Guarded on every participating customer having a POSTED batch, because closing is what
 * makes the event unbillable. `force` exists for the real-world case where a customer is
 * being written off or invoiced outside the app; it is recorded in the audit row so the
 * override is never invisible.
 */
export async function closeEvent(
  eventId: number,
  admin: AdminActor,
  options: { force?: boolean } = {}
): Promise<CloseEventResult> {
  return withTx(async (client) => {
    const event = await lockEvent(client, eventId);
    if (!event) return { ok: false as const, reason: 'unknown-event' as const };
    if (event.closed_at) return { ok: false as const, reason: 'already-closed' as const };

    const unposted = await client.query<UnpostedCustomer>(
      `SELECT ec.customer_qbo_id AS "qboId", c.display_name AS "displayName",
              COALESCE(b.status, 'NOT_APPROVED') AS status
       FROM event_customers ec
       JOIN customers c ON c.qbo_id = ec.customer_qbo_id
       LEFT JOIN charge_batches b
              ON b.event_id = ec.event_id AND b.customer_qbo_id = ec.customer_qbo_id
       WHERE ec.event_id = $1 AND b.status IS DISTINCT FROM 'POSTED'
       ORDER BY c.display_name`,
      [eventId]
    );
    if (unposted.rows.length > 0 && !options.force) {
      return { ok: false as const, reason: 'unposted-customers' as const, customers: unposted.rows };
    }

    await client.query('UPDATE events SET closed_at = now(), active = FALSE WHERE id = $1', [eventId]);
    const tokensRevoked = await revokeEventTokens(eventId, client);
    await logAction(client, {
      action: 'close-event',
      admin,
      eventId,
      detail: {
        forced: options.force === true,
        tokensRevoked,
        unposted: unposted.rows.map((r) => ({ customer: r.qboId, status: r.status })),
      },
    });
    return { ok: true as const, tokensRevoked };
  });
}

// ---------------------------------------------------------------------------

/**
 * Row lock on the event, so a concurrent close can't slip between a mutation's guard and
 * its write (add-worker racing close would otherwise mint a link the close never revokes).
 */
async function lockEvent(
  client: pg.PoolClient,
  eventId: number
): Promise<{ id: number; closed_at: string | null } | undefined> {
  const res = await client.query<{ id: number; closed_at: string | null }>(
    'SELECT id, closed_at FROM events WHERE id = $1 FOR UPDATE',
    [eventId]
  );
  return res.rows[0];
}
