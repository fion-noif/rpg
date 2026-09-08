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

      <table className="admin-table admin-customers">
        <thead>
          <tr>
            <th>Customer</th>
            {/* NOT "Recorded by" — this column comes from `assignments` (who the manager
                pointed at this customer), not from `submissions` (who has actually recorded
                a part). Those routinely differ: a worker can be assigned and record nothing
                all weekend, and a manager adjustment during review records against no
                assigned worker at all. The two headers with the same name elsewhere
                (app/admin/usage, CustomerReview) really are about recorded lines. */}
            <th>Assigned worker(s)</th>
            <th>Invoicing</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            // Keyed on qboId, never an index: the assign panel in each row holds a one-time
            // magic link in React state, and a remount would destroy it. Filtering reorders
            // nothing, but it does change which rows are present — an index key would shift
            // panels between customers.
            <CustomerRowView
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
 * One customer, one row. The assign control lives inside the "Assigned worker(s)" cell,
 * directly under the names it changes — the affordance belongs in the column it affects,
 * not in a separate strip below where it reads as unrelated furniture.
 *
 * Still a <details>, not a button plus client state: it hides its content with CSS rather
 * than unmounting, which is what keeps a one-time magic link alive across a collapse (see
 * AssignPanel), and it opens with JavaScript off.
 */
function CustomerRowView({
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
        {/* Several workers on one customer is normal, not an edge case — a busy team splits
            a car across a mechanic and a tyre fitter. listCustomers array_aggs them
            alphabetically, so this is a stable list rather than a first-one-wins. */}
        <td>
          <div className="admin-assigned">
            {c.workers.length ? (
              c.workers.join(', ')
            ) : (
              <span className="admin-muted">nobody assigned</span>
            )}
          </div>
          {!closed && (
            <details className="admin-assign">
              <summary>+ Assign</summary>
              <AssignPanel
                eventId={eventId}
                customer={{ qboId: c.qboId, displayName: c.displayName }}
                workers={assignable}
                staff={staff}
              />
            </details>
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
    </>
  );
}
