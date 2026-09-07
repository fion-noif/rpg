'use client';

// The Customers tab, and the default view: the weekend read as a list of cars to cover.
//
// This is where setup happens now. The old page made you assign from the *worker's* row, so
// setup read "pick a worker, then remember which customers they cover"; a manager thinks
// customer-first, so each row carries its own assign panel and the "add this person to the
// event" step is folded into it.
//
// A client component because the filter removes rows, which means it owns the row list. The
// Server Actions imported here still work as form actions from inside a client component.
import { useMemo, useState } from 'react';
import { norm } from '@/src/search';
import { addCustomerAction, removeCustomerAction } from './actions';
import { AssignPanel, type AssignableWorker } from './AssignPanel';
import { BATCH_LABEL, type StaffOption } from './types';

export interface CustomerRow {
  qboId: string;
  displayName: string;
  active: boolean;
  workers: string[];
  batchStatus: 'APPROVED' | 'POSTED' | 'POST_FAILED' | null;
}

export function CustomersTable({
  eventId,
  closed,
  customers,
  pickable,
  assignableByCustomer,
  staff,
}: {
  eventId: number;
  closed: boolean;
  customers: CustomerRow[];
  pickable: { qboId: string; displayName: string }[];
  /** qboId → the event's workers not yet assigned to that customer. Computed server-side by
   *  worker id, so same-named people stay distinguishable. */
  assignableByCustomer: Record<string, AssignableWorker[]>;
  staff: StaffOption[];
}) {
  const [filter, setFilter] = useState('');

  // Matches the customer name or any of its assigned workers, so "who is Ramírez covering?"
  // is answerable from here. `norm` folds accents (src/search.ts), which matters because
  // these are real names — typing "ramirez" has to find "Ramírez".
  //
  // searchCatalog from the same module is deliberately not reused: it hardcodes
  // {id, sku, name, description} as its haystack, which a customer row is not.
  const shown = useMemo(() => {
    const terms = norm(filter).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return customers;
    return customers.filter((c) => {
      const haystack = norm(`${c.displayName} ${c.workers.join(' ')}`);
      return terms.every((t) => haystack.includes(t));
    });
  }, [customers, filter]);

  return (
    <>
      <div className="admin-filterrow">
        <input
          className="admin-input filter"
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by customer or worker"
          aria-label="Filter customers"
        />
        {/* Always shown, not just while filtering: a narrowed table must never be mistaken
            for the whole weekend. */}
        <span className="admin-filter-count">
          {shown.length === customers.length
            ? `${customers.length} customer${customers.length === 1 ? '' : 's'}`
            : `${shown.length} of ${customers.length}`}
        </span>
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Recorded by</th>
            <th>Invoicing</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            // Keyed on qboId, never an index: the assign panel below holds a one-time magic
            // link in React state, and a remount would destroy it.
            <FragmentRow
              key={c.qboId}
              c={c}
              eventId={eventId}
              closed={closed}
              assignable={assignableByCustomer[c.qboId] ?? []}
              staff={staff}
            />
          ))}
          {shown.length === 0 && (
            <tr>
              <td className="empty-cell" colSpan={4}>
                {customers.length === 0
                  ? 'No customers on this event yet — add the first one below.'
                  : 'No customers match that filter.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {!closed && (
        <form className="admin-card admin-inline admin-addrow" action={addCustomerAction}>
          <input type="hidden" name="eventId" value={eventId} />
          <div className="admin-grow">
            <label className="admin-field" htmlFor="customerQboId">
              Add a customer to this event
            </label>
            <select className="admin-input" id="customerQboId" name="customerQboId" defaultValue="" required>
              <option value="" disabled>
                — pick a QuickBooks customer —
              </option>
              {pickable.map((c) => (
                <option key={c.qboId} value={c.qboId}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </div>
          <button className="admin-btn" type="submit" disabled={pickable.length === 0}>
            Add customer
          </button>
        </form>
      )}
      {!closed && pickable.length === 0 && (
        <p className="admin-note">
          Every active QuickBooks customer is already on this event. Run <strong>Sync</strong> from
          the dashboard if someone is missing.
        </p>
      )}
    </>
  );
}

/**
 * One customer as two rows: the data, then its assign panel.
 *
 * Two rows rather than one because the panel needs the full table width, and a nested table
 * would break the column alignment that makes 50 rows scannable.
 */
function FragmentRow({
  c,
  eventId,
  closed,
  assignable,
  staff,
}: {
  c: CustomerRow;
  eventId: number;
  closed: boolean;
  assignable: AssignableWorker[];
  staff: StaffOption[];
}) {
  return (
    <>
      <tr>
        <td>
          <a href={`/admin/events/${eventId}/customers/${encodeURIComponent(c.qboId)}`}>
            {c.displayName}
          </a>
          {!c.active && <span className="admin-badge closed">inactive in QBO</span>}
        </td>
        <td>
          {c.workers.length ? (
            c.workers.join(', ')
          ) : (
            <span className="admin-muted">nobody yet</span>
          )}
        </td>
        <td>
          {c.batchStatus ? (
            <span className={`admin-badge ${c.batchStatus === 'POSTED' ? 'open' : 'closed'}`}>
              {BATCH_LABEL[c.batchStatus]}
            </span>
          ) : (
            <span className="admin-muted">not approved</span>
          )}
        </td>
        <td className="num">
          {!closed && (
            <form action={removeCustomerAction}>
              <input type="hidden" name="eventId" value={eventId} />
              <input type="hidden" name="customerQboId" value={c.qboId} />
              <button className="admin-btn small secondary" type="submit">
                Remove
              </button>
            </form>
          )}
        </td>
      </tr>
      {!closed && (
        <tr className="admin-assign-row">
          <td colSpan={4}>
            {/* <details> rather than a modal on purpose. It hides its content with CSS, so
                the panel stays mounted — collapse it after copying a one-time link, reopen
                it, and the link is still there. A dialog would need bookkeeping to match
                that, needs JS to open at all, and would cover the row you are working on. */}
            <details className="admin-assign">
              <summary>Assign a worker</summary>
              <AssignPanel
                eventId={eventId}
                customer={{ qboId: c.qboId, displayName: c.displayName }}
                workers={assignable}
                staff={staff}
              />
            </details>
          </td>
        </tr>
      )}
    </>
  );
}
