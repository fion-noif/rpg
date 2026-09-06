// The QuickBooks half of Approve & Post (design doc §18.2, §23 Rule 5; plan §4). Nothing
// here touches the database and nothing here decides anything: src/charges.ts owns the state
// machine, this module owns the four QuickBooks interactions it needs.
//
// Every function takes its QuickBooks calls as an injected `deps` object defaulting to the
// real client. That is the one dependency-injection seam in the codebase, and it exists for a
// specific reason: posting is the only path whose correctness depends on the *sequence* of
// remote calls (query-before-create), so it has to be testable without a network.
import { query, create, qboLiteral } from './client';

export interface InvoiceDeps {
  query: (sql: string) => Promise<any>;
  create: (entity: string, body: unknown) => Promise<any>;
}

const realDeps: InvoiceDeps = { query, create };

/**
 * Posting refused before anything was sent to QuickBooks, for a reason the manager can fix in
 * QuickBooks itself. Distinct from `QboError` (a request that failed) because the remediation
 * is completely different — and because there is nothing to retry until the setting changes.
 */
export class PostingBlockedError extends Error {
  readonly reason: 'custom-txn-numbers-disabled';

  constructor(reason: 'custom-txn-numbers-disabled') {
    super(REMEDIATION[reason]);
    this.name = 'PostingBlockedError';
    this.reason = reason;
  }
}

const REMEDIATION = {
  'custom-txn-numbers-disabled':
    'QuickBooks is assigning its own invoice numbers. Turn on Settings → Account and ' +
    'settings → Sales → "Custom transaction numbers" in QuickBooks, then retry. Until then ' +
    'a retry after a timeout cannot tell whether an invoice was already created.',
} as const;

/**
 * Per-process cache of the one preference we depend on. Only a *pass* is cached: if the
 * setting is off the manager is expected to go and change it, and the very next retry must
 * see the new value.
 */
let customTxnNumbersVerified = false;

/** Called by `syncFromQuickBooks` — a sync is the manager's "I changed things in QBO" signal. */
export function clearPreferencesCache(): void {
  customTxnNumbersVerified = false;
}

/**
 * Idempotency (§23 Rule 5) rests entirely on QuickBooks honouring the DocNumber we send. With
 * "Custom transaction numbers" off, QBO silently substitutes its own sequential number, so
 * query-before-create finds nothing on a retry and happily creates a second invoice. Checking
 * the preference *before* the create is what makes the timeout-retry path safe, so this is a
 * hard pre-flight, not a warning like the M0 spike had.
 */
export async function assertCustomTxnNumbers(deps: InvoiceDeps = realDeps): Promise<void> {
  if (customTxnNumbersVerified) return;
  const res = await deps.query('select * from Preferences');
  const enabled = res?.Preferences?.[0]?.SalesFormsPrefs?.CustomTxnNumbers === true;
  if (!enabled) throw new PostingBlockedError('custom-txn-numbers-disabled');
  customTxnNumbersVerified = true;
}

export interface ExistingInvoice {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
}

/** Rule 5 step 3: the query that turns a retry into an adoption instead of a duplicate. */
export async function findInvoiceByDocNumber(
  docNumber: string,
  deps: InvoiceDeps = realDeps
): Promise<ExistingInvoice | undefined> {
  const res = await deps.query(
    `select Id, SyncToken, DocNumber from Invoice where DocNumber = ${qboLiteral(docNumber)}`
  );
  return res?.Invoice?.[0];
}

export interface InvoiceLineInput {
  itemQboId: string;
  itemName: string;
  qty: number;
  unitPrice: number | null;
}

export interface InvoiceBodyInput {
  customerQboId: string;
  docNumber: string;
  eventCode: string;
  lines: InvoiceLineInput[];
}

/**
 * The draft Invoice body. Left as a draft (no EmailStatus, no send) so the bookkeeper reviews
 * and sends it from QuickBooks — the app never emails a customer (§18.2).
 *
 * `Amount` is computed here rather than left to QuickBooks: the amount of record is the one
 * from the approved snapshot (§23 Rule 4), and sending it explicitly means a later price
 * change in QBO cannot silently re-price an already-approved batch.
 */
export function buildInvoiceBody(input: InvoiceBodyInput): Record<string, unknown> {
  return {
    CustomerRef: { value: input.customerQboId },
    DocNumber: input.docNumber,
    // The one human-readable pointer back to this app, visible to the bookkeeper in QBO.
    PrivateNote: `racing-app ${input.eventCode} batch for customer ${input.customerQboId}`,
    Line: input.lines.map((line) => {
      const unitPrice = line.unitPrice ?? 0;
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: round2(line.qty * unitPrice),
        Description: line.itemName,
        SalesItemLineDetail: {
          ItemRef: { value: line.itemQboId },
          Qty: line.qty,
          UnitPrice: unitPrice,
        },
      };
    }),
  };
}

/** Money never leaves this module with floating-point dust on it. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function createInvoice(
  body: Record<string, unknown>,
  deps: InvoiceDeps = realDeps
): Promise<any> {
  return deps.create('Invoice', body);
}
