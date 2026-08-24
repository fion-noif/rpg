// Manager adjustments to a customer's parts for an event (design doc §17, plan §5).
//
// The manager never UPDATEs a worker's row: an adjustment voids the worker's line and
// writes the corrected quantity onto the manager's own tab (design doc §31, append-only).
// "The manager" is a synthetic worker per event (`workers.is_admin`, no token) sharing one
// global `staff` row named 'Manager', so `submissions.worker_id` stays NOT NULL and every
// existing query and type keeps working — readers just label those rows differently.
//
// Every operation runs in one transaction under the same two guards the worker path uses
// (`lockParticipation`): the customer must participate in the event, and the customer must
// not already be approved. Every operation also appends an `admin_actions` row, which is
// what makes §17's "edits are logged" true.
import pg from 'pg';
import { pool } from './db';
import { lockParticipation, tabFor, validateQty, type UsageLineWrite } from './usage';

/** The one global staff identity behind every event's manager worker. */
const MANAGER_STAFF_NAME = 'Manager';

export type AdminRejection =
  | 'not-participating'
  | 'tab-locked'
  | 'unknown-item'
  | 'unknown-line'
  | 'invalid-qty';

export type AdminLineResult =
  | { ok: true; line: UsageLineWrite | null } // null on the void path — nothing live remains
  | { ok: false; reason: AdminRejection };

export interface AdminQtyInput {
  eventId: number;
  customerId: string;
  itemId: string;
  qty: number;
}

export interface AdminVoidInput {
  eventId: number;
  customerId: string;
  lineId: number;
}

/**
 * Lazily creates and returns the event's manager worker id.
 *
 * One global `staff` row is reused across every event (the manager is the same person all
 * season) and gets one `workers` row per event. `staff.name` is deliberately not unique
 * (§23 Rule 1 forbids identity-by-name), so the lookup-or-create is serialised with an
 * advisory lock rather than an ON CONFLICT — without it two concurrent first-ever calls
 * could both insert a 'Manager' row. The per-event worker needs no such care: the
 * `workers_event_staff` unique index makes ON CONFLICT DO NOTHING the arbiter.
 *
 * Accepts a pool or an already-open client; the pool form opens its own transaction so the
 * advisory lock has a scope to live in.
 */
export async function adminWorkerFor(db: pg.Pool | pg.PoolClient, eventId: number): Promise<number> {
  if (db instanceof pg.Pool) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const id = await adminWorkerFor(client, eventId);
      await client.query('COMMIT');
      return id;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  await db.query(`SELECT pg_advisory_xact_lock(hashtext('rw:manager-staff'))`);

  const existingStaff = await db.query<{ id: number }>(
    `SELECT id FROM staff WHERE name = $1 ORDER BY id LIMIT 1`,
    [MANAGER_STAFF_NAME]
  );
  const staffId =
    existingStaff.rows[0]?.id ??
    (
      await db.query<{ id: number }>(`INSERT INTO staff (name, language) VALUES ($1, 'en') RETURNING id`, [
        MANAGER_STAFF_NAME,
      ])
    ).rows[0].id;

  // token_hash stays NULL: the manager signs in with the admin password, never a magic
  // link, so this row must never be reachable from `workerByToken`.
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO workers (event_id, staff_id, name, language, token_hash, is_admin)
     VALUES ($1, $2, $3, 'en', NULL, TRUE)
     ON CONFLICT (event_id, staff_id) DO NOTHING
     RETURNING id`,
    [eventId, staffId, MANAGER_STAFF_NAME]
  );
  if (inserted.rows[0]) return inserted.rows[0].id;

  const existing = await db.query<{ id: number }>(
    `SELECT id FROM workers WHERE event_id = $1 AND staff_id = $2`,
    [eventId, staffId]
  );
  return existing.rows[0].id;
}

interface LiveLine {
  id: number;
  item_qbo_id: string;
  sku: string | null;
  item_name: string;
  unit_price: string | null;
  qty: number;
  worker_id: number;
  is_admin: boolean;
}

/** Every live line for one item across every tab (workers' and the manager's own). */
async function liveLinesForItem(
  client: pg.PoolClient,
  eventId: number,
  customerId: string,
  itemId: string
): Promise<LiveLine[]> {
  const res = await client.query<LiveLine>(
    `SELECT l.id, l.item_qbo_id, l.sku, l.item_name, l.unit_price, l.qty::float AS qty,
            s.worker_id, w.is_admin
     FROM submission_lines l
     JOIN submissions s ON s.id = l.submission_id
     JOIN workers w ON w.id = s.worker_id
     WHERE s.event_id = $1 AND s.customer_qbo_id = $2 AND l.item_qbo_id = $3
       AND l.voided_at IS NULL
     ORDER BY l.id`,
    [eventId, customerId, itemId]
  );
  return res.rows;
}

async function logAction(
  client: pg.PoolClient,
  action: 'edit-qty' | 'void-line' | 'add-line',
  eventId: number,
  customerId: string,
  detail: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO admin_actions (action, event_id, customer_qbo_id, detail)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [action, eventId, customerId, JSON.stringify(detail)]
  );
}

/**
 * The shared core of edit-qty and add-line: the manager states an absolute quantity for one
 * item, and afterwards exactly one live line for that item exists — theirs.
 *
 * Absolute (not additive) like the worker API, so a double-submitted form is idempotent.
 * Any worker line for the item is voided and attributed to the manager, which is both the
 * audit trail and what keeps the total from double-counting.
 *
 * `requireActiveItem` is the only difference between the two callers: adding a part the
 * manager picked from the catalogue must respect §9/Rule 3 and refuse an item QuickBooks no
 * longer sells, whereas *correcting the quantity* of a part already recorded must keep
 * working even if that item went inactive mid-weekend — in which case the existing line's
 * own snapshot (design doc §16) is the price of record anyway.
 */
async function applyAdminQty(
  input: AdminQtyInput,
  action: 'edit-qty' | 'add-line',
  requireActiveItem: boolean
): Promise<AdminLineResult> {
  const { eventId, customerId, itemId, qty } = input;
  if (!validateQty(qty) || qty <= 0) return { ok: false, reason: 'invalid-qty' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rejection = await lockParticipation(client, eventId, customerId);
    if (rejection) {
      await client.query('ROLLBACK');
      return { ok: false, reason: rejection };
    }

    const live = await liveLinesForItem(client, eventId, customerId, itemId);
    const workerLines = live.filter((l) => !l.is_admin);
    const before = live.reduce((sum, l) => sum + l.qty, 0);

    // Snapshot: prefer whatever the existing line already carries, so a correction never
    // silently re-prices history; fall back to the current catalogue for a genuinely new
    // part (design doc §16).
    let snapshot: { sku: string | null; item_name: string; unit_price: string | number | null };
    const fromLine = live[0];
    if (fromLine && !requireActiveItem) {
      snapshot = { sku: fromLine.sku, item_name: fromLine.item_name, unit_price: fromLine.unit_price };
    } else {
      const item = await client.query<{ sku: string | null; name: string; unit_price: string | null }>(
        'SELECT sku, name, unit_price FROM items WHERE qbo_id = $1 AND active',
        [itemId]
      );
      if (item.rowCount === 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'unknown-item' };
      }
      snapshot = { sku: item.rows[0].sku, item_name: item.rows[0].name, unit_price: item.rows[0].unit_price };
    }

    const adminWorkerId = await adminWorkerFor(client, eventId);
    const tab = await tabFor(client, { eventId, workerId: adminWorkerId, customerId });
    if (tab.status !== 'SUBMITTED') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'tab-locked' };
    }

    // Void the workers' originals — never an in-place UPDATE of someone else's row (§31).
    if (workerLines.length > 0) {
      await client.query(
        `UPDATE submission_lines SET voided_at = now(), voided_by = $1, updated_at = now()
         WHERE id = ANY($2::int[]) AND voided_at IS NULL`,
        [adminWorkerId, workerLines.map((l) => l.id)]
      );
    }

    // Same partial-unique upsert the worker path uses: matches the manager's own live line
    // for this item if there is one, otherwise creates it.
    const line = await client.query<UsageLineWrite>(
      `INSERT INTO submission_lines (submission_id, item_qbo_id, sku, item_name, unit_price, qty)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (submission_id, item_qbo_id) WHERE voided_at IS NULL
       DO UPDATE SET qty = $6, sku = $3, item_name = $4, unit_price = $5, updated_at = now()
       RETURNING id, item_qbo_id AS "itemId", sku, item_name AS "itemName",
                 unit_price::float AS "unitPrice", qty::float AS qty, updated_at AS "updatedAt"`,
      [tab.id, itemId, snapshot.sku, snapshot.item_name, snapshot.unit_price, qty]
    );

    await logAction(client, action, eventId, customerId, {
      itemId,
      before,
      after: qty,
      adminWorkerId,
      lineId: line.rows[0].id,
      voided: workerLines.map((l) => ({ lineId: l.id, workerId: l.worker_id, qty: l.qty })),
    });

    await client.query('COMMIT');
    return { ok: true, line: line.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Correct the quantity of a part already recorded for this customer. */
export function adminSetQty(input: AdminQtyInput): Promise<AdminLineResult> {
  return applyAdminQty(input, 'edit-qty', false);
}

/** Add a part the workers missed. The item must still be active in QuickBooks. */
export function adminAddLine(input: AdminQtyInput): Promise<AdminLineResult> {
  return applyAdminQty(input, 'add-line', true);
}

/**
 * Remove an erroneous part (§17). Voids one live line — a worker's or the manager's own —
 * attributing the void to the manager. Same qty-0-means-void semantics as the worker path:
 * the row survives, it just stops counting.
 */
export async function adminVoidLine(input: AdminVoidInput): Promise<AdminLineResult> {
  const { eventId, customerId, lineId } = input;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rejection = await lockParticipation(client, eventId, customerId);
    if (rejection) {
      await client.query('ROLLBACK');
      return { ok: false, reason: rejection };
    }

    const adminWorkerId = await adminWorkerFor(client, eventId);

    // The (event, customer) predicate is what stops a stale or guessed line id from
    // reaching another customer's tab; it is scoping, not just a sanity check.
    const voided = await client.query<{ item_qbo_id: string; qty: number; worker_id: number }>(
      `UPDATE submission_lines l
       SET voided_at = now(), voided_by = $1, updated_at = now()
       WHERE l.id = $2 AND l.voided_at IS NULL
         AND EXISTS (
           SELECT 1 FROM submissions s
           WHERE s.id = l.submission_id AND s.event_id = $3 AND s.customer_qbo_id = $4
         )
       RETURNING l.item_qbo_id, l.qty::float AS qty,
                 (SELECT s.worker_id FROM submissions s WHERE s.id = l.submission_id) AS worker_id`,
      [adminWorkerId, lineId, eventId, customerId]
    );
    if (voided.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unknown-line' };
    }

    await logAction(client, 'void-line', eventId, customerId, {
      itemId: voided.rows[0].item_qbo_id,
      before: voided.rows[0].qty,
      after: 0,
      adminWorkerId,
      voided: [{ lineId, workerId: voided.rows[0].worker_id, qty: voided.rows[0].qty }],
    });

    await client.query('COMMIT');
    return { ok: true, line: null };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
