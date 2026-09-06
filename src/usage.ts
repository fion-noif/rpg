// Server-side "cart": each worker maintains one running tab per (event, worker, customer),
// created lazily on first add (design doc §31 — corrections are new rows/status changes,
// never destructive). A write is a single idempotent operation keyed on (customerId, itemId):
// qty > 0 sets that item's qty (not increments it); qty === 0 voids the line. Because the
// operation carries an absolute quantity, replaying it from the offline queue (src/outbox.ts)
// is safe with no per-operation id.
//
// Each worker's tab is addressed only through their own session's workerId, so a worker can
// never reach another worker's line through this API — ownership is structural, not a
// runtime check. `usageForCustomer` merges every assigned worker's tab for the UI's shared
// running list; the caller marks rows read-only when their workerId doesn't match the
// current session.
//
// Every write also serialises against the manager approving the same customer, by locking
// the (event, customer) participation row first — see `lockParticipation`.
import type pg from 'pg';
import { pool } from './db';
import { workerVisibleItemSql } from './catalog';

export const MAX_QTY = 999;

/** Bounds check for a usage qty: a non-negative integer up to MAX_QTY. 0 means "void". */
export function validateQty(qty: unknown): boolean {
  return typeof qty === 'number' && Number.isFinite(qty) && Number.isInteger(qty) && qty >= 0 && qty <= MAX_QTY;
}

export interface UsageLine {
  id: number;
  itemId: string;
  sku: string | null;
  itemName: string;
  unitPrice: number | null;
  qty: number;
  workerId: number;
  workerName: string;
  /**
   * True when the line lives on the event's synthetic manager worker (`workers.is_admin`) —
   * a manager adjustment rather than a worker entry, so callers label it "Manager".
   * Optional because the worker UI synthesizes not-yet-confirmed lines client-side and has
   * nothing to put here; every row that came from the database sets it.
   */
  isAdmin?: boolean;
  updatedAt: string;
}

/** Live (non-voided) usage lines for a customer at an event, across every worker's tab. */
export async function usageForCustomer(eventId: number, customerId: string): Promise<UsageLine[]> {
  const res = await pool.query(
    `SELECT l.id, l.item_qbo_id AS "itemId", l.sku, l.item_name AS "itemName",
            l.unit_price::float AS "unitPrice", l.qty::float AS qty,
            s.worker_id AS "workerId", w.name AS "workerName", w.is_admin AS "isAdmin",
            l.updated_at AS "updatedAt"
     FROM submission_lines l
     JOIN submissions s ON s.id = l.submission_id
     JOIN workers w ON w.id = s.worker_id
     WHERE s.event_id = $1 AND s.customer_qbo_id = $2 AND l.voided_at IS NULL
     ORDER BY l.updated_at DESC`,
    [eventId, customerId]
  );
  return res.rows;
}

export type UsageRejection = 'unknown-item' | 'tab-locked' | 'not-participating';

export interface TabKey {
  eventId: number;
  workerId: number;
  customerId: string;
}

/**
 * Upsert-and-return one running tab for (event, worker, customer) — created lazily on first
 * write and reused for the rest of the event (design doc §31).
 *
 * @internal Shared by the worker path below and the manager path in src/admin-review.ts,
 * which writes onto the event's synthetic admin worker's tab. Not part of the public API:
 * callers must already hold the participation lock (see `lockParticipation`).
 */
export async function tabFor(
  client: pg.PoolClient,
  { eventId, workerId, customerId }: TabKey
): Promise<{ id: string; status: string }> {
  const inserted = await client.query(
    `INSERT INTO submissions (id, event_id, worker_id, customer_qbo_id)
     VALUES (gen_random_uuid(), $1, $2, $3)
     ON CONFLICT (event_id, worker_id, customer_qbo_id) DO NOTHING
     RETURNING id, status`,
    [eventId, workerId, customerId]
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await client.query(
    `SELECT id, status FROM submissions
     WHERE event_id = $1 AND worker_id = $2 AND customer_qbo_id = $3`,
    [eventId, workerId, customerId]
  );
  return existing.rows[0];
}

/**
 * The two guards that must run *before* any tab or line is touched (plan §3, the approve
 * race). `event_customers` always has a row for a legitimate write, which is why it — and
 * not the tab, which may not exist yet — is the lock row:
 *
 * - `FOR SHARE` serialises this write against approve's `FOR UPDATE` on the same row, while
 *   letting concurrent workers through. Without it, a worker with *no existing tab* could
 *   create one and land a line just after approval snapshotted the aggregate.
 * - The `charge_batches` probe is the actual "is this customer approved?" test. Checking the
 *   tab's status alone misses the same no-tab-yet case.
 *
 * @internal
 */
export async function lockParticipation(
  client: pg.PoolClient,
  eventId: number,
  customerId: string
): Promise<UsageRejection | null> {
  const participating = await client.query(
    `SELECT 1 FROM event_customers WHERE event_id = $1 AND customer_qbo_id = $2 FOR SHARE`,
    [eventId, customerId]
  );
  if (participating.rowCount === 0) return 'not-participating';

  const batch = await client.query(
    `SELECT 1 FROM charge_batches WHERE event_id = $1 AND customer_qbo_id = $2`,
    [eventId, customerId]
  );
  if (batch.rowCount !== 0) return 'tab-locked';

  return null;
}

/**
 * The approve side of the same lock: `FOR UPDATE` on the participation row, which excludes
 * every concurrent `FOR SHARE` writer above until this transaction commits.
 *
 * A sibling rather than a mode flag on `lockParticipation` because the two callers want
 * different answers from the second half of that helper: a worker write must stop at
 * `'tab-locked'` when a batch exists, whereas approve *creates* that batch and detects a
 * double-approve from its own `ON CONFLICT DO NOTHING` claim instead.
 *
 * @returns false when the customer does not participate in the event.
 * @internal
 */
export async function lockParticipationForUpdate(
  client: pg.PoolClient,
  eventId: number,
  customerId: string
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM event_customers WHERE event_id = $1 AND customer_qbo_id = $2 FOR UPDATE`,
    [eventId, customerId]
  );
  return res.rowCount !== 0;
}

export interface SetUsageQtyInput {
  workerId: number;
  eventId: number;
  customerId: string;
  itemId: string;
  qty: number;
}

export interface UsageLineWrite {
  id: number;
  itemId: string;
  sku: string | null;
  itemName: string;
  unitPrice: number | null;
  qty: number;
  updatedAt: string;
}

export type SetUsageQtyResult =
  | { ok: true; line: UsageLineWrite | null } // line is null when the qty:0 void path ran
  | { ok: false; reason: UsageRejection };

export async function setUsageQty(input: SetUsageQtyInput): Promise<SetUsageQtyResult> {
  const { workerId, eventId, customerId, itemId, qty } = input;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // First statements in the transaction, before anything is created: participation lock
    // then approval check (plan §3).
    const rejection = await lockParticipation(client, eventId, customerId);
    if (rejection) {
      await client.query('ROLLBACK');
      return { ok: false, reason: rejection };
    }

    const tab = await tabFor(client, { eventId, workerId, customerId });

    if (tab.status !== 'SUBMITTED') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'tab-locked' };
    }

    if (qty === 0) {
      await client.query(
        `UPDATE submission_lines
         SET voided_at = now(), voided_by = $1, updated_at = now()
         WHERE submission_id = $2 AND item_qbo_id = $3 AND voided_at IS NULL`,
        [workerId, tab.id, itemId]
      );
      await client.query('COMMIT');
      return { ok: true, line: null };
    }

    // Snapshot name/price at write time (design doc §16) — only items this *worker* may
    // record are addable.
    //
    // The same predicate as the catalogue the worker was served, not merely `active`: hiding
    // a manager-only service item from the picker is presentation, and presentation is not
    // authorisation (§8 least privilege). A worker who guesses or replays a service item's
    // QuickBooks id must be refused here, in the transaction, or a $450/day line lands on a
    // customer's invoice under a worker's name.
    //
    // Rejected as the existing `'unknown-item'` rather than a new reason: from the worker's
    // side that is the whole truth — no such item exists in their catalogue — and a distinct
    // "this is a manager item" reason would only teach a prober that the id was real. The UI
    // gains nothing from the distinction because no legitimate worker action can reach it.
    const item = await client.query(
      `SELECT sku, name, unit_price FROM items WHERE qbo_id = $1 AND ${workerVisibleItemSql()}`,
      [itemId]
    );
    if (item.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unknown-item' };
    }

    // Partial-unique upsert: matches the live (voided_at IS NULL) row for this item, if any;
    // a previously-voided line for the same item doesn't conflict, so re-adding after a
    // remove creates a fresh live row rather than resurrecting the old one.
    const line = await client.query(
      `INSERT INTO submission_lines (submission_id, item_qbo_id, sku, item_name, unit_price, qty)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (submission_id, item_qbo_id) WHERE voided_at IS NULL
       DO UPDATE SET qty = $6, sku = $3, item_name = $4, unit_price = $5, updated_at = now()
       RETURNING id, item_qbo_id AS "itemId", sku, item_name AS "itemName",
                 unit_price::float AS "unitPrice", qty::float AS qty, updated_at AS "updatedAt"`,
      [tab.id, itemId, item.rows[0].sku, item.rows[0].name, item.rows[0].unit_price, qty]
    );

    await client.query('COMMIT');
    return { ok: true, line: line.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
