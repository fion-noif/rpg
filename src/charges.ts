// Approve & Post: the two-phase state machine that turns a weekend's worker entries into one
// draft QuickBooks invoice per customer per event (design doc §18.2, §23 Rules 3/4/5; plan §4).
//
// Two phases because a database transaction cannot be held across an HTTP call:
//
//   approveBatch  — one transaction. Claims the batch, freezes the customer's tabs, and
//                   persists the aggregate. Nothing remote happens; if this commits, the
//                   amounts are final and reconstructable forever (Rule 4).
//   postBatch     — no transaction spans the QuickBooks call. Instead: a claim transaction,
//                   the remote work under a session advisory lock, then a record transaction.
//                   Every interruption in between is recoverable by retrying, because a retry
//                   queries QuickBooks by DocNumber first and adopts whatever it finds (Rule 5).
//
// The invariant that makes all of this safe is that the DocNumber is *deterministic*:
// `RW-{eventCode}-{customerQboId}` is a pure function of the batch's identity, so the same
// batch always looks itself up under the same name, on every retry, from any process.
import type pg from 'pg';
import { pool } from './db';
import { lockParticipationForUpdate } from './usage';
import { EVENT_CODE_RE } from './admin/events';
import type { AdminActor } from './admin/admins';
import { QboError } from './qbo/client';
import {
  assertCustomTxnNumbers,
  buildInvoiceBody,
  createInvoice,
  findInvoiceByDocNumber,
  PostingBlockedError,
  type InvoiceDeps,
} from './qbo/invoice';

/**
 * QuickBooks truncates DocNumber at 21 characters, and a truncated DocNumber is worse than a
 * rejected one: two customers could collide onto the same invoice. `RW-` + 8 + `-` + 9 + `-`
 * = 21 exactly, so the two guards below are the whole 21-char budget, enforced by construction
 * rather than by a length check after the fact.
 */
const CUSTOMER_ID_RE = /^[0-9]{1,9}$/;

/**
 * The idempotency anchor (§23 Rule 5). Throws rather than truncates or sanitises: a batch
 * whose DocNumber we cannot form is a batch we cannot post safely, and silently mangling the
 * name would break the query-before-create guarantee that prevents double-charging.
 *
 * The event code is already constrained at the form, in `EVENT_CODE_RE`, and by a CHECK on
 * `events` — this is the fourth and last line of that defence.
 */
export function docNumberFor(eventCode: string, customerQboId: string): string {
  if (!EVENT_CODE_RE.test(eventCode)) {
    throw new Error(`Unusable event code for a QuickBooks DocNumber: ${JSON.stringify(eventCode)}`);
  }
  if (!CUSTOMER_ID_RE.test(customerQboId)) {
    throw new Error(
      `Unusable QuickBooks customer id for a DocNumber: ${JSON.stringify(customerQboId)}`
    );
  }
  return `RW-${eventCode}-${customerQboId}`;
}

export interface BatchLine {
  id: number;
  itemQboId: string;
  sku: string | null;
  itemName: string;
  unitPrice: number | null;
  qty: number;
}

export interface Batch {
  id: number;
  eventId: number;
  customerQboId: string;
  docNumber: string;
  status: 'APPROVED' | 'POSTED' | 'POST_FAILED';
  qboInvoiceId: string | null;
  qboSyncToken: string | null;
  postAttempts: number;
  lastAttemptAt: string | null;
  postError: string | null;
  docNumberMismatch: boolean;
  createdAt: string;
  postedAt: string | null;
}

const BATCH_COLUMNS = `id, event_id AS "eventId", customer_qbo_id AS "customerQboId",
        doc_number AS "docNumber", status, qbo_invoice_id AS "qboInvoiceId",
        qbo_sync_token AS "qboSyncToken", post_attempts AS "postAttempts",
        last_attempt_at AS "lastAttemptAt", post_error AS "postError",
        doc_number_mismatch AS "docNumberMismatch", created_at AS "createdAt",
        posted_at AS "postedAt"`;

// ---------------------------------------------------------------------------
// Reads for the UI
// ---------------------------------------------------------------------------

export async function batchFor(eventId: number, customerId: string): Promise<Batch | undefined> {
  const res = await pool.query<Batch>(
    `SELECT ${BATCH_COLUMNS} FROM charge_batches WHERE event_id = $1 AND customer_qbo_id = $2`,
    [eventId, customerId]
  );
  return res.rows[0];
}

export async function batchWithLines(
  batchId: number
): Promise<{ batch: Batch; lines: BatchLine[] } | undefined> {
  const batch = (
    await pool.query<Batch>(`SELECT ${BATCH_COLUMNS} FROM charge_batches WHERE id = $1`, [batchId])
  ).rows[0];
  if (!batch) return undefined;
  return { batch, lines: await readLines(pool, batchId) };
}

async function readLines(db: pg.Pool | pg.PoolClient, batchId: number): Promise<BatchLine[]> {
  return (
    await db.query<BatchLine>(
      `SELECT id, item_qbo_id AS "itemQboId", sku, item_name AS "itemName",
              unit_price::float AS "unitPrice", qty::float AS qty
       FROM charge_batch_lines WHERE batch_id = $1 ORDER BY item_name, unit_price`,
      [batchId]
    )
  ).rows;
}

async function logAction(
  client: pg.PoolClient,
  action: 'approve' | 'post' | 'post-failed' | 'unapprove',
  entry: {
    eventId: number;
    customerQboId: string;
    /** Deliberately null for `unapprove`: the batch row is about to disappear. */
    batchId: number | null;
    /**
     * Null only where there genuinely is no person: a retry driven by something other than a
     * signed-in admin. Every HTTP surface requires a cookie, so in practice this is set.
     */
    admin: AdminActor | null;
    detail: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO admin_actions (action, event_id, customer_qbo_id, batch_id, admin_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      action,
      entry.eventId,
      entry.customerQboId,
      entry.batchId,
      entry.admin?.id ?? null,
      JSON.stringify({ ...entry.detail, by: entry.admin?.name ?? null }),
    ]
  );
}

// ---------------------------------------------------------------------------
// Phase 1 — approve
// ---------------------------------------------------------------------------

export type ApproveRejection =
  | 'unknown-event'
  | 'event-closed'
  | 'not-participating'
  | 'already-approved'
  | 'nothing-to-approve'
  | 'unusable-doc-number';

export type ApproveResult =
  | { ok: true; batchId: number; docNumber: string; lines: BatchLine[] }
  | { ok: false; reason: ApproveRejection }
  | { ok: false; reason: 'inactive-item'; items: { itemQboId: string; itemName: string }[] };

/**
 * Freeze one customer's parts for one event and persist the aggregate that will be invoiced.
 *
 * The statement order inside the transaction is the whole design (plan §3) and is not
 * incidental:
 *
 *  1. `FOR UPDATE` on the participation row. Every worker write takes `FOR SHARE` on the same
 *     row first, so from here on no new line can land — including from a worker who has no tab
 *     yet, which is the case a status check on existing tabs would miss entirely.
 *  2. Claim the batch with `ON CONFLICT DO NOTHING`. The unique index on
 *     (event_id, customer_qbo_id) makes the database, not this code, the arbiter of a
 *     double-click; zero rows returned means somebody else already approved.
 *  3. Rule 3 pre-flight. Refuse the whole batch if any part has gone inactive in QuickBooks,
 *     before any state has changed — posting a line QuickBooks no longer sells fails remotely
 *     and much less legibly.
 *  4. Flip the tabs, *then* aggregate. Both orders are correct under the lock, but flipping
 *     first means a bug that loses the lock degrades to "nothing more can be added" rather
 *     than "additions after the snapshot are silently uninvoiced".
 */
export async function approveBatch(input: {
  eventId: number;
  customerId: string;
  /** Who approved. Freezing a customer's billing is the most consequential manager act there is. */
  admin: AdminActor;
}): Promise<ApproveResult> {
  const { eventId, customerId, admin } = input;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!(await lockParticipationForUpdate(client, eventId, customerId))) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not-participating' };
    }

    const event = (
      await client.query<{ code: string; closed_at: string | null }>(
        'SELECT code, closed_at FROM events WHERE id = $1',
        [eventId]
      )
    ).rows[0];
    if (!event) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unknown-event' };
    }
    if (event.closed_at) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'event-closed' };
    }

    // A code or customer id that cannot form a safe DocNumber is a refusal, not a crash: the
    // manager can act on "this customer's QuickBooks id is not postable".
    let docNumber: string;
    try {
      docNumber = docNumberFor(event.code, customerId);
    } catch {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unusable-doc-number' };
    }

    const claim = await client.query<{ id: number }>(
      `INSERT INTO charge_batches (event_id, customer_qbo_id, doc_number)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, customer_qbo_id) DO NOTHING
       RETURNING id`,
      [eventId, customerId, docNumber]
    );
    if (claim.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already-approved' };
    }
    const batchId = claim.rows[0].id;

    // §23 Rule 3: inactive in QuickBooks means unsellable, so the batch is refused as a whole
    // rather than posted minus a line the manager never agreed to drop.
    const inactive = await client.query<{ itemQboId: string; itemName: string }>(
      `SELECT DISTINCT l.item_qbo_id AS "itemQboId", l.item_name AS "itemName"
       FROM submission_lines l
       JOIN submissions s ON s.id = l.submission_id
       JOIN items i ON i.qbo_id = l.item_qbo_id
       WHERE s.event_id = $1 AND s.customer_qbo_id = $2 AND l.voided_at IS NULL AND NOT i.active
       ORDER BY 2`,
      [eventId, customerId]
    );
    if (inactive.rows.length > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'inactive-item', items: inactive.rows };
    }

    await client.query(
      `UPDATE submissions SET status = 'APPROVED', charge_batch_id = $1
       WHERE event_id = $2 AND customer_qbo_id = $3 AND status = 'SUBMITTED'`,
      [batchId, eventId, customerId]
    );

    // One invoice line per (item, price snapshot). Grouping by price as well as item is what
    // keeps the invoice total equal to the review page's total when two workers recorded the
    // same part at different prices (design doc §16) — collapsing them would require inventing
    // a unit price that matches neither. sku/item_name are per-snapshot too in principle;
    // min() picks one deterministically, and they only ever differ if the catalogue was
    // renamed mid-weekend.
    const lines = await client.query<BatchLine>(
      `INSERT INTO charge_batch_lines (batch_id, item_qbo_id, sku, item_name, unit_price, qty)
       SELECT $1, l.item_qbo_id, min(l.sku), min(l.item_name), l.unit_price, sum(l.qty)
       FROM submission_lines l
       JOIN submissions s ON s.id = l.submission_id
       WHERE s.event_id = $2 AND s.customer_qbo_id = $3 AND l.voided_at IS NULL
       GROUP BY l.item_qbo_id, l.unit_price
       RETURNING id, item_qbo_id AS "itemQboId", sku, item_name AS "itemName",
                 unit_price::float AS "unitPrice", qty::float AS qty`,
      [batchId, eventId, customerId]
    );
    if (lines.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'nothing-to-approve' };
    }

    await logAction(client, 'approve', {
      eventId,
      customerQboId: customerId,
      batchId,
      admin,
      detail: { docNumber, lines: lines.rows, total: totalOf(lines.rows) },
    });

    await client.query('COMMIT');
    return { ok: true, batchId, docNumber, lines: lines.rows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function totalOf(lines: BatchLine[]): number {
  return Math.round(lines.reduce((sum, l) => sum + l.qty * (l.unitPrice ?? 0), 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Phase 2 — post
// ---------------------------------------------------------------------------

/**
 * `afterCreate` exists only so a test can simulate the one genuinely dangerous crash window —
 * the invoice exists in QuickBooks but this process died before recording it. Production never
 * passes it; the recovery path it exercises (retry re-queries and adopts) is the reason the
 * DocNumber is deterministic in the first place.
 */
export interface PostDeps extends InvoiceDeps {
  afterCreate?: () => Promise<void>;
}

export type PostResult =
  | {
      ok: true;
      batchId: number;
      invoiceId: string;
      docNumber: string;
      /** True when the invoice already existed in QuickBooks and was adopted, not created. */
      adopted: boolean;
      docNumberMismatch: boolean;
    }
  | { ok: false; reason: 'unknown-batch' | 'already-posted' | 'in-flight' | 'no-lines' }
  | {
      ok: false;
      reason: 'qbo-error' | 'blocked';
      /** 5xx, timeouts and network failures are worth retrying; a 4xx needs a human first. */
      retryable: boolean;
      message: string;
    };

/**
 * Send the approved aggregate to QuickBooks as a draft invoice, at most once.
 *
 * "At most once" is enforced at three levels, because each catches a different failure:
 *
 *  - A session advisory lock held across the HTTP call stops two concurrent posts (a
 *    double-click, or the retry button while the first attempt is still in flight) from both
 *    reaching the query-before-create window and both concluding "no invoice exists".
 *  - The claim UPDATE's `status IN ('APPROVED','POST_FAILED')` predicate stops a second post
 *    of an already-POSTED batch.
 *  - Query-before-create by DocNumber catches everything else, including a previous attempt
 *    that created the invoice and then lost the answer (timeout, crash, killed container).
 *
 * Reads `charge_batch_lines` only, never `submission_lines` (§23 Rule 4): what gets invoiced
 * is what was approved, even if a tab moved afterwards.
 */
export async function postBatch(
  batchId: number,
  admin: AdminActor | null,
  deps?: PostDeps
): Promise<PostResult> {
  const client = await pool.connect();
  let locked = false;
  try {
    // Session-scoped, not transaction-scoped: it has to outlive the claim transaction and
    // span the HTTP call, which is precisely the window a transaction cannot cover.
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [`post:${batchId}`]
    );
    if (!lock.rows[0].acquired) return { ok: false, reason: 'in-flight' };
    locked = true;

    // --- Claim transaction -------------------------------------------------
    // The attempt counter is incremented *before* the remote call, so "we may have created an
    // invoice we don't know about" is durable even if this process dies mid-flight. That is
    // what un-approve keys off (post_attempts > 0 ⇒ refuse, retry to find out).
    await client.query('BEGIN');
    const claim = await client.query<Batch>(
      `UPDATE charge_batches
       SET post_attempts = post_attempts + 1, last_attempt_at = now(), post_error = NULL
       WHERE id = $1 AND status IN ('APPROVED', 'POST_FAILED')
       RETURNING ${BATCH_COLUMNS}`,
      [batchId]
    );
    if (claim.rows.length === 0) {
      await client.query('ROLLBACK');
      const exists = await client.query('SELECT 1 FROM charge_batches WHERE id = $1', [batchId]);
      return { ok: false, reason: exists.rowCount ? 'already-posted' : 'unknown-batch' };
    }
    const batch = claim.rows[0];

    // Mirror the batch onto the tabs it covers, so a retry-in-progress reads as APPROVED
    // rather than leaving stale POST_FAILED tabs behind a successful post (§26 states).
    await client.query(
      `UPDATE submissions SET status = 'APPROVED' WHERE charge_batch_id = $1 AND status = 'POST_FAILED'`,
      [batchId]
    );

    const lines = await readLines(client, batchId);
    const event = (
      await client.query<{ code: string }>('SELECT code FROM events WHERE id = $1', [batch.eventId])
    ).rows[0];
    await client.query('COMMIT');

    if (lines.length === 0) {
      // Cannot happen through approveBatch (which refuses an empty aggregate); a hand-edited
      // database can still get here, and sending QuickBooks a zero-line invoice is worse.
      await recordFailure(client, batch, admin, 'Batch has no approved lines to invoice.');
      return { ok: false, reason: 'no-lines' };
    }

    // --- Remote work (no transaction open) ---------------------------------
    let invoice: { Id: string; SyncToken: string; DocNumber?: string };
    let adopted: boolean;
    try {
      await assertCustomTxnNumbers(deps);

      const existing = await findInvoiceByDocNumber(batch.docNumber, deps);
      if (existing) {
        invoice = existing;
        adopted = true;
      } else {
        invoice = await createInvoice(
          buildInvoiceBody({
            customerQboId: batch.customerQboId,
            docNumber: batch.docNumber,
            eventCode: event.code,
            lines: lines.map((l) => ({
              itemQboId: l.itemQboId,
              itemName: l.itemName,
              qty: l.qty,
              unitPrice: l.unitPrice,
            })),
          }),
          deps
        );
        adopted = false;
        if (deps?.afterCreate) await deps.afterCreate();
      }
    } catch (err) {
      const failure = describeFailure(err);
      await recordFailure(client, batch, admin, failure.message);
      return { ok: false, ...failure };
    }

    // --- Record transaction ------------------------------------------------
    // If QuickBooks ignored our DocNumber the invoice is still recorded: an orphaned invoice
    // in QuickBooks is unrecoverable by any retry, whereas a flagged one is a warning the
    // manager can act on.
    const mismatch = invoice.DocNumber != null && invoice.DocNumber !== batch.docNumber;
    await client.query('BEGIN');
    await client.query(
      `UPDATE charge_batches
       SET qbo_invoice_id = $2, qbo_sync_token = $3, status = 'POSTED', posted_at = now(),
           post_error = NULL, doc_number_mismatch = $4
       WHERE id = $1`,
      [batchId, invoice.Id, invoice.SyncToken ?? null, mismatch]
    );
    await client.query(
      `UPDATE submissions SET status = 'POSTED_TO_QUICKBOOKS' WHERE charge_batch_id = $1`,
      [batchId]
    );
    await logAction(client, 'post', {
      eventId: batch.eventId,
      customerQboId: batch.customerQboId,
      batchId,
      admin,
      detail: {
        docNumber: batch.docNumber,
        invoiceId: invoice.Id,
        adopted,
        docNumberMismatch: mismatch,
        returnedDocNumber: invoice.DocNumber ?? null,
        attempt: batch.postAttempts,
        total: totalOf(lines),
      },
    });
    await client.query('COMMIT');

    return {
      ok: true,
      batchId,
      invoiceId: invoice.Id,
      docNumber: batch.docNumber,
      adopted,
      docNumberMismatch: mismatch,
    };
  } catch (err) {
    // Any error reaching here is a bug or a dead database, not a QuickBooks refusal — the
    // rollback is best-effort so it can never mask the original throw.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`post:${batchId}`]);
    client.release();
  }
}

/**
 * Classify a failed attempt for the UI. The distinction that matters to the manager is not the
 * error text but whether the Retry button is worth pressing: a 4xx means QuickBooks understood
 * us and said no, so retrying the identical request will fail identically.
 */
function describeFailure(err: unknown): {
  reason: 'qbo-error' | 'blocked';
  retryable: boolean;
  message: string;
} {
  if (err instanceof PostingBlockedError) {
    // Retryable in the sense that matters: fix the setting in QuickBooks, press Retry.
    return { reason: 'blocked', retryable: true, message: err.message };
  }
  if (err instanceof QboError) {
    const fault = [err.fault?.message, err.fault?.detail].filter(Boolean).join(' — ');
    return {
      reason: 'qbo-error',
      retryable: err.status >= 500,
      message: `QuickBooks returned ${err.status}${err.fault?.code ? ` (${err.fault.code})` : ''}: ${
        fault || err.body || err.message
      }`,
    };
  }
  // Timeout, DNS, connection reset: the request may or may not have been applied, which is
  // exactly the case the DocNumber query on the next attempt resolves.
  return {
    reason: 'qbo-error',
    retryable: true,
    message: `Could not reach QuickBooks: ${(err as Error)?.message ?? String(err)}`,
  };
}

async function recordFailure(
  client: pg.PoolClient,
  batch: Batch,
  admin: AdminActor | null,
  message: string
): Promise<void> {
  await client.query('BEGIN');
  await client.query(
    `UPDATE charge_batches SET status = 'POST_FAILED', post_error = $2 WHERE id = $1`,
    [batch.id, message]
  );
  await client.query(
    `UPDATE submissions SET status = 'POST_FAILED' WHERE charge_batch_id = $1 AND status = 'APPROVED'`,
    [batch.id]
  );
  await logAction(client, 'post-failed', {
    eventId: batch.eventId,
    customerQboId: batch.customerQboId,
    batchId: batch.id,
    admin,
    detail: { docNumber: batch.docNumber, attempt: batch.postAttempts, error: message },
  });
  await client.query('COMMIT');
}

// ---------------------------------------------------------------------------
// Un-approve
// ---------------------------------------------------------------------------

export type UnapproveResult =
  | { ok: true; eventId: number; customerQboId: string }
  | { ok: false; reason: 'unknown-batch' | 'posted' | 'has-post-attempts' };

/**
 * Undo an approval that never left the building, reopening the customer for edits.
 *
 * Permitted only while `qbo_invoice_id IS NULL AND post_attempts = 0`. The `post_attempts`
 * half is the non-obvious one: after a failed attempt we do not know whether QuickBooks
 * created the invoice, and un-approving would drop the local record that lets a retry find and
 * adopt it — turning an unknown into an orphan. Retry first; it resolves the unknown either
 * way. Once POSTED there is no un-approve at all: the invoice belongs to QuickBooks now
 * (§23 Rule 2) and the correction happens there.
 *
 * The aggregate is snapshotted into `admin_actions.detail` before deletion, so "what was
 * approved and then withdrawn" survives (§31 append-only, in spirit — the batch row itself is
 * a derived cache of the tabs it came from).
 */
export async function unapproveBatch(
  batchId: number,
  admin: AdminActor
): Promise<UnapproveResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const identity = (
      await client.query<{ event_id: number; customer_qbo_id: string }>(
        'SELECT event_id, customer_qbo_id FROM charge_batches WHERE id = $1',
        [batchId]
      )
    ).rows[0];
    if (!identity) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unknown-batch' };
    }

    // Same lock order as approveBatch — participation row first, then the batch — so the two
    // can never deadlock against each other.
    await lockParticipationForUpdate(client, identity.event_id, identity.customer_qbo_id);
    const batch = (
      await client.query<Batch>(`SELECT ${BATCH_COLUMNS} FROM charge_batches WHERE id = $1 FOR UPDATE`, [
        batchId,
      ])
    ).rows[0];
    if (!batch) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unknown-batch' };
    }
    if (batch.status === 'POSTED' || batch.qboInvoiceId !== null) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'posted' };
    }
    if (batch.postAttempts > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'has-post-attempts' };
    }

    const lines = await readLines(client, batchId);
    // batch_id is left null: the FK is ON DELETE SET NULL, so pointing at a row we are about
    // to delete would erase the link anyway. The id lives in the detail instead.
    await logAction(client, 'unapprove', {
      eventId: batch.eventId,
      customerQboId: batch.customerQboId,
      batchId: null,
      admin,
      detail: {
        batchId,
        docNumber: batch.docNumber,
        lines,
        total: totalOf(lines),
        approvedAt: batch.createdAt,
      },
    });

    // Order matters: submissions.charge_batch_id is a foreign key, so it has to let go before
    // the batch can be deleted.
    await client.query(
      `UPDATE submissions
       SET status = CASE WHEN status = 'APPROVED' THEN 'SUBMITTED' ELSE status END,
           charge_batch_id = NULL
       WHERE charge_batch_id = $1`,
      [batchId]
    );
    await client.query('DELETE FROM charge_batch_lines WHERE batch_id = $1', [batchId]);
    await client.query('DELETE FROM charge_batches WHERE id = $1', [batchId]);

    await client.query('COMMIT');
    return { ok: true, eventId: batch.eventId, customerQboId: batch.customerQboId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
