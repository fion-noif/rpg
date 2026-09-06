'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { strings, type Lang } from '@/src/i18n';
import { searchCatalog } from '@/src/search';
import { classifyWriteFailure, enqueue, remove, type UsageOp } from '@/src/outbox';
import type { UsageLine } from '@/src/usage';

export interface CatalogItem {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  price: number | null;
  category: string | null;
}

interface Customer {
  qbo_id: string;
  display_name: string;
}

/** A usage line as rendered: server truth, optionally overlaid with a not-yet-confirmed op. */
interface DisplayLine extends UsageLine {
  pending?: boolean;
}

const QUEUE_KEY = 'rw_usage_queue';

function loadQueue(): UsageOp[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveQueue(queue: UsageOp[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

// Popular/search rows are for selection only — no quantity shown here. Tapping Add always
// adds one more to the worker's own line; adjusting or removing an amount happens in the
// used-parts list below, which is where a quantity is meaningful.
function PartRow({
  item,
  addLabel,
  onAdd,
  disabled,
}: {
  item: CatalogItem;
  addLabel: string;
  onAdd: () => void;
  disabled: boolean;
}) {
  return (
    <div className="part-row">
      <div className="info">
        <div className="name">{item.name}</div>
        {item.sku && <div className="sku">{item.sku}</div>}
      </div>
      <button className="add-btn" onClick={onAdd} disabled={disabled}>
        {addLabel}
      </button>
    </div>
  );
}

export default function WorkerApp(props: {
  worker: { id: number; name: string; language: Lang; eventName: string };
  customers: Customer[];
  catalog: CatalogItem[];
  popularIds: string[];
  usageByCustomer: Record<string, UsageLine[]>;
  /**
   * Customers the manager has already approved (a `charge_batches` row exists), as of the
   * server render. Their sections render read-only; the flush loop adds to this set if a
   * write races an approval that happened after the page loaded.
   */
  lockedByCustomer: Record<string, boolean>;
}) {
  const { customers, catalog, popularIds } = props;
  const [lang, setLang] = useState<Lang>(props.worker.language);
  const t = strings[lang];

  const [customerId, setCustomerId] = useState<string | null>(
    customers.length === 1 ? customers[0].qbo_id : null
  );
  const customer = customers.find((c) => c.qbo_id === customerId) ?? null;

  const [search, setSearch] = useState('');
  const [usage, setUsage] = useState<Record<string, UsageLine[]>>(props.usageByCustomer);
  const [queue, setQueue] = useState<UsageOp[]>([]);
  const [saveError, setSaveError] = useState(false);
  const [lockedIds, setLockedIds] = useState<string[]>(() =>
    Object.keys(props.lockedByCustomer).filter((id) => props.lockedByCustomer[id])
  );
  const flushing = useRef(false);

  const locked = customerId !== null && lockedIds.includes(customerId);

  const catalogById = useMemo(() => new Map(catalog.map((i) => [i.id, i])), [catalog]);

  async function refreshUsage(forCustomerId: string) {
    try {
      const res = await fetch(`/api/usage?customerId=${encodeURIComponent(forCustomerId)}`);
      if (!res.ok) return;
      const data = await res.json();
      setUsage((u) => ({ ...u, [forCustomerId]: data.lines }));
    } catch {
      // Best-effort refresh; server state stays what it was, queue still covers unsent edits.
    }
  }

  // --- Write-behind queue: replay until the server has committed (design doc §31) ---
  async function flushQueue() {
    if (flushing.current) return;
    flushing.current = true;
    try {
      let q = loadQueue();
      const touched = new Set<string>();
      for (const op of [...q]) {
        try {
          const res = await fetch('/api/usage', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(op),
          });
          if (res.ok) {
            q = remove(q, op);
            saveQueue(q);
            touched.add(op.customerId);
          } else {
            // Rejected — do not retry forever; drop and surface it (design doc §31 durability
            // rule cuts the other way here: the worker must know a write did NOT land).
            // `tab-locked` gets its own message: the manager approved this customer, so the
            // app is working exactly as intended and "try again" would be a lie.
            const body = await res.text();
            const outcome = classifyWriteFailure(res.status, body);
            if (outcome === 'retry') continue;
            console.error('Usage write rejected', body);
            q = remove(q, op);
            saveQueue(q);
            if (outcome === 'locked') {
              setLockedIds((ids) => (ids.includes(op.customerId) ? ids : [...ids, op.customerId]));
            } else {
              setSaveError(true);
            }
            touched.add(op.customerId);
          }
        } catch {
          // Network failure: keep in queue, retry on next tick.
          break;
        }
      }
      setQueue(q);
      for (const id of touched) await refreshUsage(id);
    } finally {
      flushing.current = false;
    }
  }

  useEffect(() => {
    setQueue(loadQueue());
    flushQueue();
    const timer = setInterval(flushQueue, 8000);
    const onOnline = () => flushQueue();
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick up edits made by other workers (or from an earlier session) while this one is open.
  useEffect(() => {
    if (customerId) refreshUsage(customerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  function toggleLang() {
    const next: Lang = lang === 'en' ? 'es' : 'en';
    setLang(next);
    fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: next }),
    }).catch(() => {});
  }

  // --- Search / listing ---
  const results = useMemo(() => searchCatalog(catalog, search), [search, catalog]);

  const popular = useMemo(() => {
    const fromUsage = popularIds.map((id) => catalogById.get(id)).filter(Boolean) as CatalogItem[];
    return fromUsage.length > 0 ? fromUsage : catalog.slice(0, 5);
  }, [catalog, popularIds, catalogById]);

  // Server lines for the selected customer, overlaid with this device's not-yet-confirmed
  // edits so the UI is optimistic even before the queue drains.
  const displayLines = useMemo<DisplayLine[]>(() => {
    if (!customer) return [];
    const byItem = new Map<string, DisplayLine>(
      (usage[customer.qbo_id] ?? []).map((l) => [l.itemId, l])
    );
    for (const op of queue) {
      if (op.customerId !== customer.qbo_id) continue;
      if (op.qty === 0) {
        byItem.delete(op.itemId);
        continue;
      }
      const existing = byItem.get(op.itemId);
      const catalogItem = catalogById.get(op.itemId);
      byItem.set(op.itemId, {
        id: existing?.id ?? -1,
        itemId: op.itemId,
        sku: existing?.sku ?? catalogItem?.sku ?? null,
        itemName: existing?.itemName ?? catalogItem?.name ?? op.itemId,
        unitPrice: existing?.unitPrice ?? catalogItem?.price ?? null,
        qty: op.qty,
        workerId: props.worker.id,
        workerName: props.worker.name,
        updatedAt: new Date().toISOString(),
        pending: true,
      });
    }
    return [...byItem.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }, [usage, queue, customer, catalogById, props.worker.id, props.worker.name]);

  const myQty = useMemo(() => {
    const m = new Map<string, number>();
    for (const line of displayLines) if (line.workerId === props.worker.id) m.set(line.itemId, line.qty);
    return m;
  }, [displayLines, props.worker.id]);

  function setQty(itemId: string, qty: number) {
    if (!customer || locked) return;
    const op: UsageOp = { customerId: customer.qbo_id, itemId, qty: Math.max(0, qty) };
    const next = enqueue(loadQueue(), op);
    saveQueue(next);
    setQueue(next);
    setSaveError(false);
    flushQueue();
  }

  const pendingCount = queue.length;

  return (
    <div className="wrap">
      <div className="topbar">
        <span className="who">{props.worker.name}</span>
        <button className="lang-toggle" onClick={toggleLang}>
          {lang === 'en' ? 'Español' : 'English'}
        </button>
      </div>

      {customers.length === 1 && customer && (
        <div className="customer-bar">
          {t.customer}: {customer.display_name}
        </div>
      )}
      {customers.length > 1 && (
        <>
          <div className="section-title">{t.selectCustomer}</div>
          <div className="customer-tabs">
            {customers.map((c) => (
              <button
                key={c.qbo_id}
                className={c.qbo_id === customerId ? 'active' : ''}
                onClick={() => setCustomerId(c.qbo_id)}
              >
                {c.display_name}
              </button>
            ))}
          </div>
        </>
      )}

      {pendingCount > 0 && (
        <div className="status-note pending">
          {t.pending} ({pendingCount}) — {t.offlineNote}
        </div>
      )}
      {pendingCount === 0 && !saveError && !locked && (
        <div className="status-note ok">{t.confirmed} ✓</div>
      )}
      {saveError && <div className="status-note error">{t.saveFailed}</div>}
      {locked && <div className="status-note locked">{t.tabLocked}</div>}

      {customer && (
        <>
          <div className="section-title">
            {t.partsUsedFor} {customer.display_name}
          </div>
          {displayLines.length === 0 && <div className="empty">{t.nothingRecorded}</div>}
          {displayLines.map((line) => {
            const mine = line.workerId === props.worker.id;
            return (
              <div className="usage-row" key={line.itemId}>
                <div className="info">
                  <div className="name">
                    {line.itemName}
                    {line.pending ? ' …' : ''}
                  </div>
                  {!mine && (
                    // Always the stored name (M3). Admin lines carry the admin's real name
                    // now, because their staff row is named after their account — so a worker
                    // sees "by Mike Rolison", not "by Manager". The one exception needs no
                    // code: pre-M3 rows are literally named 'Manager', which is still the
                    // truthful label for a line the shared password recorded.
                    <div className="sku">
                      {t.recordedBy} {line.workerName}
                    </div>
                  )}
                </div>
                {mine && !locked ? (
                  <div className="qty-controls">
                    <button onClick={() => setQty(line.itemId, line.qty - 1)}>−</button>
                    <span className="qty">{line.qty}</span>
                    <button onClick={() => setQty(line.itemId, line.qty + 1)}>+</button>
                  </div>
                ) : (
                  <span className="qty readonly">×{line.qty}</span>
                )}
              </div>
            );
          })}
        </>
      )}

      <div className="section-title">{t.addParts}</div>
      <input
        className="search"
        type="search"
        placeholder={`🔍 ${t.searchParts}`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {results !== null ? (
        <>
          <div className="section-subtitle">{t.allParts}</div>
          {results.length === 0 && <div className="empty">{t.noResults}</div>}
          {results.map((item) => (
            <PartRow
              key={item.id}
              item={item}
              addLabel={t.add}
              disabled={locked}
              onAdd={() => setQty(item.id, (myQty.get(item.id) ?? 0) + 1)}
            />
          ))}
        </>
      ) : (
        <>
          <div className="section-subtitle">{t.popularParts}</div>
          {popular.map((item) => (
            <PartRow
              key={item.id}
              item={item}
              addLabel={t.add}
              disabled={locked}
              onAdd={() => setQty(item.id, (myQty.get(item.id) ?? 0) + 1)}
            />
          ))}
        </>
      )}
    </div>
  );
}
