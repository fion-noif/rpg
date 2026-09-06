// Demo-data housekeeping: delete transactions from the QuickBooks sandbox and bring the
// local mirror back in line with it.
//
// This is a *demo* operation and nothing else. It exists so a tester handed the app sees an
// empty invoice list and knows that any invoice appearing later came from their own
// Approve & Post — which is the behaviour they are being asked to test. It is guarded by the
// sandbox-only check in src/qbo/catalog.ts and must never be pointed at real books.
//
// Note the asymmetry with master data: a transaction can genuinely be deleted, whereas a
// Customer or Item with history can only be flagged inactive (design doc §23 Rule 3). That
// is why this module deletes and the catalog seeder flags.
import { queryAll, remove, QboError } from './client';
import { pool } from './../db';

/** The default target: what a tester must not see before they have posted anything. */
export const INVOICES_ONLY = ['Invoice'] as const;

/**
 * Every transaction type Intuit's stock landscaping demo company ships with.
 *
 * Needed because deactivating the stock *customers* — the point of the exercise — is
 * refused by QuickBooks while they still carry a balance or an unbilled charge, and both
 * come from these rows. Deleting the invoices alone made it worse, not better: it left the
 * Payments that had been applied to them stranded as unapplied credits, i.e. a *negative*
 * balance, which blocks deactivation just as firmly.
 *
 * Order matters, and is "whatever links to X, before X": Payments and CreditMemos before the
 * Invoices they apply to, BillPayments before their Bills. QuickBooks otherwise has to
 * unwind a link on a row that is already gone, and refuses.
 *
 * The accounts-payable rows at the end (Bill, BillPayment, JournalEntry) are here for one
 * reason only: a *billable* expense line on a Bill counts as an unbilled charge against the
 * customer it names, and that blocks deactivating the customer just as an open balance does.
 * Nothing on the AP side is visible to a tester of this app; it is collateral to clearing
 * the customer picker.
 *
 * Expect to run this twice. QuickBooks evaluates links per request, so a row whose blocker
 * is deleted later in the same pass only becomes deletable on the next one. Both passes are
 * safe — the second finds nothing left to do.
 */
export const STOCK_DEMO_TRANSACTIONS = [
  'Payment',
  'CreditMemo',
  'RefundReceipt',
  'SalesReceipt',
  'Invoice',
  'Estimate',
  'TimeActivity',
  'Purchase',
  'Deposit',
  'BillPayment',
  'Bill',
  'JournalEntry',
] as const;

export interface PurgeFailure {
  entity: string;
  id: string;
  docNumber: string | null;
  message: string;
}

export interface PurgeResult {
  found: number;
  deleted: number;
  /** Per-entity `[found, deleted]`, so the operator can see what actually shifted. */
  byEntity: Record<string, { found: number; deleted: number }>;
  failures: PurgeFailure[];
  /** Local `charge_batches` rows removed (their lines cascade). */
  batchesCleared: number;
  /** Local tabs whose POSTED/APPROVED status pointed at a now-deleted batch. */
  submissionsReset: number;
}

/**
 * Delete the given transaction entities, then clear the local rows that claimed to have
 * created invoices.
 *
 * Order matters and is the opposite of the usual: QuickBooks first, database second. A
 * `charge_batches` row whose invoice is gone is a lie the app would act on — posting would
 * refuse as `already-posted` — whereas a deleted invoice with the local row still present is
 * a state a retry can recover from. So the durable claim is dropped only after the thing it
 * claims is actually gone.
 */
export async function purgeTransactions(
  entities: readonly string[] = INVOICES_ONLY
): Promise<PurgeResult> {
  const failures: PurgeFailure[] = [];
  const byEntity: PurgeResult['byEntity'] = {};
  let found = 0;
  let deleted = 0;

  for (const entity of entities) {
    const rows = await queryAll(entity);
    byEntity[entity] = { found: rows.length, deleted: 0 };
    found += rows.length;
    for (const row of rows) {
      try {
        await remove(entity, { Id: row.Id, SyncToken: row.SyncToken });
        deleted += 1;
        byEntity[entity].deleted += 1;
      } catch (err) {
        // Collected rather than thrown: one undeletable row (linked payment, closed period)
        // should not leave the other thirty-three behind.
        failures.push({
          entity,
          id: row.Id,
          docNumber: row.DocNumber ?? null,
          message: err instanceof QboError ? (err.fault?.detail ?? err.fault?.message ?? err.message) : String(err),
        });
      }
    }
  }

  const { batchesCleared, submissionsReset } = await clearLocalBatches();
  return { found, deleted, byEntity, failures, batchesCleared, submissionsReset };
}

/** Back-compat convenience: the invoices-only purge, which is what the demo flow wants. */
export function purgeAllInvoices(): Promise<PurgeResult> {
  return purgeTransactions(INVOICES_ONLY);
}

async function clearLocalBatches(): Promise<{ batchesCleared: number; submissionsReset: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Detach the tabs first: submissions.charge_batch_id is a plain FK with no cascade, and
    // a tab left at POSTED_TO_QUICKBOOKS with no batch renders as posted with no invoice.
    const tabs = await client.query(
      `UPDATE submissions SET status = 'SUBMITTED', charge_batch_id = NULL
       WHERE charge_batch_id IS NOT NULL RETURNING id`
    );
    // charge_batch_lines cascades on batch delete; admin_actions.batch_id is SET NULL, so
    // the audit trail survives as history with no dangling pointer.
    const batches = await client.query('DELETE FROM charge_batches RETURNING id');
    await client.query('COMMIT');
    return { batchesCleared: batches.rowCount ?? 0, submissionsReset: tabs.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
