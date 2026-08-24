'use client';

// The interactive half of the §17 review: change a quantity, remove an erroneous part, add
// a missing one. Every action is one PUT to /api/admin/lines followed by router.refresh(),
// so what the manager sees after an edit is always re-read server state rather than an
// optimistic guess — this page is the last stop before money goes to QuickBooks, and it is
// used on a desk, not offline in a paddock (contrast app/WorkerApp.tsx's write-behind queue).

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { searchCatalog } from '@/src/search';

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
}

export interface CatalogOption {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  price: number | null;
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
}

function money(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(2)}`;
}

export default function CustomerReview(props: {
  eventId: number;
  customerId: string;
  lines: ReviewLine[];
  catalog: CatalogOption[];
  batchStatus: string | null;
}) {
  const router = useRouter();
  const locked = props.batchStatus != null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [addItemId, setAddItemId] = useState('');
  const [addQty, setAddQty] = useState('1');
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

  const results = useMemo(() => searchCatalog(props.catalog, search) ?? props.catalog.slice(0, 30), [
    props.catalog,
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

  return (
    <>
      {error && <div className="admin-alert">{error}</div>}
      {locked && (
        <div className="admin-alert">
          Approved ({props.batchStatus}) — this customer&rsquo;s parts are locked. Workers and the
          manager can no longer change them.
        </div>
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Part</th>
            <th>SKU</th>
            <th className="num">Qty</th>
            <th className="num">Unit price</th>
            <th className="num">Line total</th>
            <th>Recorded by</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.itemId}>
              <td>{g.itemName}</td>
              <td>{g.sku ?? ''}</td>
              <td className="num">{g.qty}</td>
              <td className="num">{money(g.unitPrice)}</td>
              <td className="num">{money(g.total)}</td>
              <td>{g.submitters.join(', ')}</td>
              <td className="admin-row-actions">
                <input
                  className="admin-input qty"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  aria-label={`New quantity for ${g.itemName}`}
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
          <tr>
            <th colSpan={4}>Total</th>
            <th className="num">{money(runningTotal)}</th>
            <th colSpan={2}>{anyUnpriced ? 'excludes parts with no price' : ''}</th>
          </tr>
        </tfoot>
      </table>

      <div className="admin-card admin-add-part">
        <h2>Add a missing part</h2>
        <p className="admin-note">
          Added parts are attributed to the Manager. Only parts QuickBooks still sells are
          listed.
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
                    <td className="num">{l.qty}</td>
                    <td>{l.submittedBy}</td>
                    <td>{l.voidedBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------
          PLACEHOLDER — Approve & Post (design doc §17, plan §4/§7).
          Deliberately not implemented here: approving writes the charge_batches
          row and posts a draft invoice to QuickBooks, which is the next task in
          the plan. Nothing on this page approves anything today.
          ------------------------------------------------------------------ */}
      <div className="admin-card admin-placeholder">
        <h2>Approve &amp; Post</h2>
        <p className="admin-note">
          Not available yet — approving this customer and posting the draft invoice to
          QuickBooks lands in the next step of the M2 plan.
        </p>
      </div>
    </>
  );
}
