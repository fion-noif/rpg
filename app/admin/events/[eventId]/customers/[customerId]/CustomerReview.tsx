'use client';

// The interactive half of the §17 review: change a quantity, remove an erroneous part, add
// a missing one. Every action is one PUT to /api/admin/lines followed by router.refresh(),
// so what the manager sees after an edit is always re-read server state rather than an
// optimistic guess — this page is the last stop before money goes to QuickBooks, and it is
// used on a desk, not offline in a paddock (contrast app/WorkerApp.tsx's write-behind queue).

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { searchCatalog } from '@/src/search';
import type { Batch, BatchLine } from '@/src/charges';

export interface ReviewLine {
  id: number;
  itemId: string;
  sku: string | null;
  itemName: string;
  unitPrice: number | null;
  qty: number;
  updatedAt: string;
  voided: boolean;
  submittedBy: string;
  voidedBy: string | null;
  /**
   * A manager-only service item rather than a physical part (`Race Services`, src/catalog.ts).
   * Changes only how the row reads: its quantity is a number of **race days**, not units.
   */
  isService: boolean;
}

export interface CatalogOption {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  price: number | null;
  /** True for the manager-only service items. Workers never receive one of these. */
  isService: boolean;
}

/** One row of the review: every live line for the same part, collapsed (design doc §17). */
interface ItemGroup {
  itemId: string;
  itemName: string;
  sku: string | null;
  unitPrice: number | null;
  qty: number;
  total: number | null;
  submitters: string[];
  lineIds: number[];
  isService: boolean;
}

function money(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(2)}`;
}

/**
 * Quantity as the manager should read it. Services are billed per race **day** and parts per
 * unit (owner's decision, 09/06/2026), and both are whole numbers — so this is a label, not a
 * different number format. Spelling out "3 days" next to "Mechanic (per day)" is what makes
 * the line total arithmetically obvious at the last stop before money moves.
 */
function qtyLabel(qty: number, isService: boolean): string {
  if (!isService) return String(qty);
  return `${qty} ${qty === 1 ? 'day' : 'days'}`;
}

export default function CustomerReview(props: {
  eventId: number;
  customerId: string;
  lines: ReviewLine[];
  catalog: CatalogOption[];
  eventClosed: boolean;
  batch: Batch | null;
  batchLines: BatchLine[];
}) {
  const router = useRouter();
  // Any batch at all locks the customer, whatever its posting state: the aggregate has been
  // snapshotted, so further edits could no longer change what QuickBooks is told (§23 Rule 4).
  const locked = props.batch != null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [addItemId, setAddItemId] = useState('');
  const [addQty, setAddQty] = useState('1');
  // Separate state from the part picker above: a half-filled "add a part" must not silently
  // submit itself when the manager reaches for the service control instead.
  const [addServiceId, setAddServiceId] = useState('');
  const [addServiceDays, setAddServiceDays] = useState('1');
  const [showAudit, setShowAudit] = useState(false);

  const live = props.lines.filter((l) => !l.voided);
  const voided = props.lines.filter((l) => l.voided);

  const groups = useMemo<ItemGroup[]>(() => {
    const byItem = new Map<string, ItemGroup>();
    for (const line of live) {
      const g = byItem.get(line.itemId) ?? {
        itemId: line.itemId,
        itemName: line.itemName,
        sku: line.sku,
        unitPrice: line.unitPrice,
        qty: 0,
        total: 0,
        submitters: [],
        lineIds: [],
        isService: line.isService,
      };
      g.qty += line.qty;
      // Two workers can have recorded the same part at different price snapshots
      // (design doc §16). Sum the money rather than the fictional single unit price, and
      // blank the unit-price column when they disagree so the number is never misleading.
      if (g.lineIds.length > 0 && g.unitPrice !== line.unitPrice) g.unitPrice = null;
      g.total = g.total == null || line.unitPrice == null ? null : g.total + line.qty * line.unitPrice;
      if (!g.submitters.includes(line.submittedBy)) g.submitters.push(line.submittedBy);
      g.lineIds.push(line.id);
      byItem.set(line.itemId, g);
    }
    return [...byItem.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));
  }, [live]);

  const runningTotal = groups.reduce((sum, g) => sum + (g.total ?? 0), 0);
  const anyUnpriced = groups.some((g) => g.total == null);

  // Split only for the readout, never for the arithmetic: `runningTotal` above is still the
  // single sum of every line, because that sum — tax-inclusive by the owner's billing model
  // — is the amount of record that goes to QuickBooks (§23 Rule 4, §28 n.28). These two
  // subtotals exist so a manager can see at a glance how much of an invoice is labour.
  const partsTotal = groups.reduce((sum, g) => (g.isService ? sum : sum + (g.total ?? 0)), 0);
  const servicesTotal = groups.reduce((sum, g) => (g.isService ? sum + (g.total ?? 0) : sum), 0);
  const hasServiceLines = groups.some((g) => g.isService);

  // Parts and services are searched and picked separately (two controls, not one list with a
  // divider) because they are priced in different units: mixing "× 4 tyres" and "× 3 days"
  // in one dropdown is how a manager bills three days of a $52 tyre.
  const partOptions = useMemo(() => props.catalog.filter((i) => !i.isService), [props.catalog]);
  const serviceOptions = useMemo(() => props.catalog.filter((i) => i.isService), [props.catalog]);

  const results = useMemo(() => searchCatalog(partOptions, search) ?? partOptions.slice(0, 30), [
    partOptions,
    search,
  ]);

  async function send(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/lines', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: props.eventId, customerId: props.customerId, ...body }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          data.error === 'tab-locked'
            ? 'This customer has already been approved — no more changes.'
            : `Could not save: ${data.error ?? res.status}`
        );
        return false;
      }
      return true;
    } catch {
      setError('Could not reach the server — try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveQty(itemId: string) {
    const qty = Number(drafts[itemId]);
    if (!Number.isInteger(qty) || qty <= 0) {
      setError('Quantity must be a whole number greater than zero — use Remove to delete a part.');
      return;
    }
    if (await send({ op: 'set', itemId, qty })) {
      setDrafts((d) => ({ ...d, [itemId]: '' }));
      router.refresh();
    }
  }

  async function removeGroup(group: ItemGroup) {
    // Voiding is per line (each carries its own author for the audit trail), so a part two
    // workers both recorded takes one call each.
    for (const lineId of group.lineIds) {
      if (!(await send({ op: 'void', lineId }))) return;
    }
    router.refresh();
  }

  async function addPart() {
    const qty = Number(addQty);
    if (!addItemId) {
      setError('Pick a part to add.');
      return;
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      setError('Quantity must be a whole number greater than zero.');
      return;
    }
    if (await send({ op: 'add', itemId: addItemId, qty })) {
      setAddItemId('');
      setAddQty('1');
      setSearch('');
      router.refresh();
    }
  }

  /**
   * Add a service line — the same `op: 'add'` the parts path uses, so this reuses
   * `adminAddLine` and its lock, snapshot, void-the-worker's-line and `admin_actions`
   * behaviour verbatim (src/admin-review.ts). The only difference is what the quantity means
   * to the person typing it: days, not units.
   */
  async function addService() {
    const days = Number(addServiceDays);
    if (!addServiceId) {
      setError('Pick a service to add.');
      return;
    }
    // Whole days, deliberately: services are charged per race day, and half a race day is
    // not a thing anyone bills. Same integer rule as parts, so `validateQty` needs no
    // fractional-quantity support (§28 n.29).
    if (!Number.isInteger(days) || days <= 0) {
      setError('Days must be a whole number greater than zero.');
      return;
    }
    if (await send({ op: 'add', itemId: addServiceId, qty: days })) {
      setAddServiceId('');
      setAddServiceDays('1');
      router.refresh();
    }
  }

  return (
    <>
      {error && <div className="admin-alert">{error}</div>}
      {locked && (
        <div className="admin-alert">
          Approved ({props.batch!.status}) — this customer&rsquo;s parts are locked. Workers and
          the manager can no longer change them.
        </div>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Part or service</th>
            <th>SKU</th>
            <th className="num">Qty / Days</th>
            <th className="num">Unit / day price</th>
            <th className="num">Line total</th>
            <th>Recorded by</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.itemId}>
              <td>
                {g.itemName}
                {g.isService && <span className="admin-tag service">service · per day</span>}
              </td>
              <td>{g.sku ?? ''}</td>
              <td className="num">{qtyLabel(g.qty, g.isService)}</td>
              <td className="num">
                {money(g.unitPrice)}
                {g.isService && g.unitPrice != null && <span className="admin-unit">/day</span>}
              </td>
              <td className="num">{money(g.total)}</td>
              <td>{g.submitters.join(', ')}</td>
              <td className="admin-row-actions">
                <input
                  className="admin-input qty"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  aria-label={
                    g.isService ? `New number of days for ${g.itemName}` : `New quantity for ${g.itemName}`
                  }
                  placeholder={String(g.qty)}
                  value={drafts[g.itemId] ?? ''}
                  disabled={locked || busy}
                  onChange={(e) => setDrafts((d) => ({ ...d, [g.itemId]: e.target.value }))}
                />
                <button
                  className="admin-btn secondary"
                  disabled={locked || busy || !drafts[g.itemId]}
                  onClick={() => saveQty(g.itemId)}
                >
                  Save
                </button>
                <button
                  className="admin-btn secondary"
                  disabled={locked || busy}
                  onClick={() => removeGroup(g)}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {groups.length === 0 && (
            <tr>
              <td className="empty-cell" colSpan={7}>
                Nothing recorded for this customer yet.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          {hasServiceLines && (
            <>
              <tr>
                <th colSpan={4}>Parts</th>
                <th className="num">{money(partsTotal)}</th>
                <th colSpan={2} />
              </tr>
              <tr>
                <th colSpan={4}>Services (billed by the day)</th>
                <th className="num">{money(servicesTotal)}</th>
                <th colSpan={2} />
              </tr>
            </>
          )}
          <tr>
            <th colSpan={4}>Total</th>
            <th className="num">{money(runningTotal)}</th>
            {/* Tax-inclusive by the owner's billing model: this sum IS the invoice total, and
                the app never adds tax to it (§28 n.28). */}
            <th colSpan={2}>
              {anyUnpriced ? 'excludes parts with no price · ' : ''}
              tax included
            </th>
          </tr>
        </tfoot>
      </table>

      <div className="admin-card admin-add-part">
        <h2>Add a missing part</h2>
        <p className="admin-note">
          Added parts are attributed to you by name. Only parts QuickBooks still sells are
          listed. Services are added separately, below.
        </p>
        <input
          className="admin-input"
          type="search"
          placeholder="Search parts"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={locked || busy}
        />
        <div className="admin-add-row">
          <select
            className="admin-input"
            aria-label="Part to add"
            value={addItemId}
            disabled={locked || busy}
            onChange={(e) => setAddItemId(e.target.value)}
          >
            <option value="">Select a part…</option>
            {results.map((item) => (
              <option key={item.id} value={item.id}>
                {item.sku ? `${item.sku} — ` : ''}
                {item.name}
                {item.price == null ? '' : ` (${money(item.price)})`}
              </option>
            ))}
          </select>
          <input
            className="admin-input qty"
            type="number"
            min={1}
            inputMode="numeric"
            aria-label="Quantity to add"
            value={addQty}
            disabled={locked || busy}
            onChange={(e) => setAddQty(e.target.value)}
          />
          <button className="admin-btn" disabled={locked || busy} onClick={addPart}>
            Add
          </button>
        </div>
      </div>

      {/* Services: a separate card, not another row in the picker above. Managers only —
          workers never see these items at all (§8), and their unit is a race day, so putting
          them next to per-unit parts in one list invites exactly the wrong arithmetic. */}
      {serviceOptions.length > 0 && (
        <div className="admin-card admin-add-service">
          <h2>Add a service</h2>
          <p className="admin-note">
            Services are billed <strong>by the race day</strong> — enter the number of days, not a
            quantity. Workers cannot see or record these; only managers can add them, and the line
            is attributed to you by name.
          </p>
          <div className="admin-add-row">
            <select
              className="admin-input"
              aria-label="Service to add"
              value={addServiceId}
              disabled={locked || busy}
              onChange={(e) => setAddServiceId(e.target.value)}
            >
              <option value="">Select a service…</option>
              {serviceOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.sku ? `${item.sku} — ` : ''}
                  {item.name}
                  {item.price == null ? '' : ` (${money(item.price)}/day)`}
                </option>
              ))}
            </select>
            <label className="admin-days">
              <span>Days</span>
              <input
                className="admin-input qty"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                aria-label="Days to bill"
                value={addServiceDays}
                disabled={locked || busy}
                onChange={(e) => setAddServiceDays(e.target.value)}
              />
            </label>
            <button className="admin-btn" disabled={locked || busy} onClick={addService}>
              Add service
            </button>
          </div>
        </div>
      )}

      {voided.length > 0 && (
        <div className="admin-card admin-audit">
          <button className="admin-btn secondary" onClick={() => setShowAudit((s) => !s)}>
            {showAudit ? 'Hide' : 'Show'} removed and corrected entries ({voided.length})
          </button>
          {showAudit && (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Part</th>
                  <th className="num">Qty</th>
                  <th>Recorded by</th>
                  <th>Removed by</th>
                </tr>
              </thead>
              <tbody>
                {voided.map((l) => (
                  <tr key={l.id} className="voided">
                    <td>{l.itemName}</td>
                    <td className="num">{qtyLabel(l.qty, l.isService)}</td>
                    <td>{l.submittedBy}</td>
                    <td>{l.voidedBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <ApprovePost
        eventId={props.eventId}
        customerId={props.customerId}
        batch={props.batch}
        batchLines={props.batchLines}
        eventClosed={props.eventClosed}
        hasLines={groups.length > 0}
        runningTotal={runningTotal}
      />
    </>
  );
}

/** Copy for every rejection reason the two phases can return, keyed by the wire value. */
const POST_ERRORS: Record<string, string> = {
  'event-closed': 'This event is closed — nothing more can be invoiced from it.',
  'not-participating': 'This customer is not on this event.',
  'already-approved': 'Somebody else just approved this customer — reload to see the batch.',
  'nothing-to-approve': 'Nothing is recorded for this customer, so there is nothing to invoice.',
  'inactive-item':
    'One or more parts are no longer sold in QuickBooks. Remove or replace them, then approve again.',
  'unusable-doc-number':
    "This customer's QuickBooks id cannot form an invoice number. Re-sync from QuickBooks.",
  'already-posted': 'This batch is already posted.',
  'in-flight': 'Another attempt is running right now — wait a moment and reload.',
  'has-post-attempts':
    'This batch has already been sent to QuickBooks at least once. Retry the post first: ' +
    'that is what tells us whether an invoice exists.',
  posted: 'Posted invoices belong to QuickBooks — correct it there (§23 Rule 2).',
  'no-lines': 'This batch has no lines to invoice.',
};

/**
 * The Approve & Post panel (plan §4/§7). Renders the batch's state machine, because the state
 * is exactly what the manager needs to know: not approved / approved but unposted / attempted
 * with an unknown outcome / failed with a reason / posted.
 *
 * The state worth spelling out is `post_attempts > 0` with no invoice id: QuickBooks may or may
 * not have created the invoice. Un-approve is refused there on purpose — a retry re-queries by
 * DocNumber and settles it either way, whereas un-approving would leave the invoice orphaned.
 */
function ApprovePost(props: {
  eventId: number;
  customerId: string;
  batch: Batch | null;
  batchLines: BatchLine[];
  eventClosed: boolean;
  hasLines: boolean;
  runningTotal: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const batch = props.batch;

  async function call(url: string, body?: unknown) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        post?: { ok?: boolean; reason?: string; message?: string; adopted?: boolean };
      };
      if (!res.ok) {
        setError(POST_ERRORS[data.error ?? ''] ?? data.message ?? `Failed: ${data.error ?? res.status}`);
      } else if (data.post && data.post.ok === false) {
        // Phase 1 committed, phase 2 did not. The batch now exists and Retry is the next step.
        setError(
          `Approved, but posting to QuickBooks failed: ${
            data.post.message ?? POST_ERRORS[data.post.reason ?? ''] ?? data.post.reason
          }`
        );
      } else if (data.post?.adopted) {
        setNote('An invoice with this number already existed in QuickBooks — adopted it, no duplicate.');
      }
    } catch {
      setError('Could not reach the server — reload to see whether it went through.');
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const total = props.batchLines.length
    ? props.batchLines.reduce((sum, l) => sum + l.qty * (l.unitPrice ?? 0), 0)
    : props.runningTotal;

  // "Attempted, outcome unknown": the only state in which neither Approve nor Un-approve is
  // offered and Retry is the single sensible action.
  const unknownOutcome =
    batch != null && batch.status === 'APPROVED' && batch.postAttempts > 0 && batch.qboInvoiceId === null;

  return (
    <div className="admin-card admin-post">
      <h2>Approve &amp; Post</h2>

      {error && <div className="status-note error">{error}</div>}
      {note && <div className="status-note ok">{note}</div>}

      {batch == null && (
        <>
          <p className="admin-note">
            Approving freezes this customer&rsquo;s parts and creates one draft invoice in
            QuickBooks ({money(total)}). The invoice is left as a draft for the bookkeeper to
            review and send.
          </p>
          <button
            className="admin-btn"
            disabled={busy || props.eventClosed || !props.hasLines}
            onClick={() => call('/api/admin/batches', { eventId: props.eventId, customerId: props.customerId })}
          >
            {busy ? 'Working…' : 'Approve & Post'}
          </button>
          {props.eventClosed && <p className="admin-note">This event is closed.</p>}
          {!props.eventClosed && !props.hasLines && (
            <p className="admin-note">Nothing is recorded for this customer yet.</p>
          )}
        </>
      )}

      {batch != null && (
        <>
          {batch.docNumberMismatch && (
            <div className="status-note error">
              QuickBooks assigned its own invoice number instead of {batch.docNumber}. The invoice
              was created and is recorded here, but duplicate protection can no longer be verified
              for it — check invoice {batch.qboInvoiceId} in QuickBooks by hand, and turn on
              Settings → Account and settings → Sales → &ldquo;Custom transaction numbers&rdquo;.
            </div>
          )}

          <table className="admin-table">
            <tbody>
              <tr>
                <th>Invoice number</th>
                <td className="mono">{batch.docNumber}</td>
              </tr>
              <tr>
                <th>State</th>
                <td>
                  {batch.status === 'POSTED' && (
                    <span className="admin-badge open">Posted to QuickBooks</span>
                  )}
                  {batch.status === 'POST_FAILED' && <span className="admin-badge closed">Post failed</span>}
                  {batch.status === 'APPROVED' &&
                    (unknownOutcome ? (
                      <span className="admin-badge closed">Attempted — outcome unknown</span>
                    ) : (
                      <span className="admin-badge">Approved, not posted</span>
                    ))}
                </td>
              </tr>
              <tr>
                <th>Approved total</th>
                <td>{money(total)}</td>
              </tr>
              {batch.qboInvoiceId && (
                <tr>
                  <th>QuickBooks invoice id</th>
                  <td className="mono">{batch.qboInvoiceId}</td>
                </tr>
              )}
              {batch.postAttempts > 0 && (
                <tr>
                  <th>Post attempts</th>
                  <td>{batch.postAttempts}</td>
                </tr>
              )}
            </tbody>
          </table>

          {batch.postError && (
            <>
              <p className="admin-note">QuickBooks said:</p>
              {/* Verbatim, unmapped: a QuickBooks Fault is the only thing that can tell the
                  manager (or whoever they forward it to) what actually went wrong. */}
              <pre className="admin-pre">{batch.postError}</pre>
            </>
          )}

          {unknownOutcome && (
            <p className="admin-note">
              A post was attempted but we never learned the outcome. Retry to reconcile: it looks
              the invoice up in QuickBooks by number and adopts it if it is already there.
            </p>
          )}

          <div className="admin-inline">
            {batch.status !== 'POSTED' && (
              <button
                className="admin-btn"
                disabled={busy}
                onClick={() => call(`/api/admin/batches/${batch.id}/post`)}
              >
                {busy ? 'Working…' : batch.postAttempts > 0 ? 'Retry post' : 'Post to QuickBooks'}
              </button>
            )}
            {batch.status === 'APPROVED' && batch.postAttempts === 0 && batch.qboInvoiceId === null && (
              <button
                className="admin-btn secondary"
                disabled={busy}
                onClick={() => {
                  if (!confirm('Un-approve this customer? The approved invoice lines are discarded and workers can edit again.')) return;
                  void call(`/api/admin/batches/${batch.id}/unapprove`);
                }}
              >
                Un-approve
              </button>
            )}
          </div>

          {batch.status === 'POST_FAILED' && batch.postAttempts > 0 && (
            <p className="admin-note">
              Un-approve is unavailable after a post attempt. Retry first — that is what
              establishes whether an invoice already exists in QuickBooks.
            </p>
          )}
          {batch.status === 'POSTED' && (
            <p className="admin-note">
              Posted invoices are QuickBooks&rsquo; now: correct or void this one there, not here.
            </p>
          )}
        </>
      )}
    </div>
  );
}
