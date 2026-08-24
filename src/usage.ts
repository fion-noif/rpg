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
import { pool } from './db';

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
  updatedAt: string;
}

/** Live (non-voided) usage lines for a customer at an event, across every worker's tab. */
export async function usageForCustomer(eventId: number, customerId: string): Promise<UsageLine[]> {
  const res = await pool.query(
    `SELECT l.id, l.item_qbo_id AS "itemId", l.sku, l.item_name AS "itemName",
            l.unit_price::float AS "unitPrice", l.qty::float AS qty,
            s.worker_id AS "workerId", w.name AS "workerName", l.updated_at AS "updatedAt"
     FROM submission_lines l
     JOIN submissions s ON s.id = l.submission_id
     JOIN workers w ON w.id = s.worker_id
     WHERE s.event_id = $1 AND s.customer_qbo_id = $2 AND l.voided_at IS NULL
     ORDER BY l.updated_at DESC`,
    [eventId, customerId]
  );
  return res.rows;
}

export type UsageRejection = 'unknown-item' | 'tab-locked';

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

    // Upsert this worker's tab for this customer at this event (design doc §31: created
    // lazily, reused for the rest of the event).
    const inserted = await client.query(
      `INSERT INTO submissions (id, event_id, worker_id, customer_qbo_id)
       VALUES (gen_random_uuid(), $1, $2, $3)
       ON CONFLICT (event_id, worker_id, customer_qbo_id) DO NOTHING
       RETURNING id, status`,
      [eventId, workerId, customerId]
    );
    const tabRow =
      inserted.rows[0] ??
      (
        await client.query(
          `SELECT id, status FROM submissions
           WHERE event_id = $1 AND worker_id = $2 AND customer_qbo_id = $3`,
          [eventId, workerId, customerId]
        )
      ).rows[0];
    const tab: { id: string; status: string } = tabRow;

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

    // Snapshot name/price at write time (design doc §16) — only active items are addable.
    const item = await client.query('SELECT sku, name, unit_price FROM items WHERE qbo_id = $1 AND active', [
      itemId,
    ]);
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
