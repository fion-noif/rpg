// Event detail: who is billed, who is recording, and who can see what (plan §7).
//
// Thin controller — every read is one call into src/admin/events.ts and every write is a
// Server Action in ./actions.ts (that file explains why actions rather than route handlers
// on this page). Server-rendered, no client state except the two components that display a
// freshly minted magic link.
import { notFound } from 'next/navigation';
import { requireAdminPage } from '@/src/admin-page-auth';
import {
  availableCustomers,
  getEvent,
  listCustomers,
  listWorkers,
} from '@/src/admin/events';
import { listStaff } from '@/src/admin/staff';
import {
  addCustomerAction,
  assignAction,
  closeEventAction,
  removeCustomerAction,
  removeWorkerAction,
  unassignAction,
  updateEventDatesAction,
} from './actions';
import { AddWorkerForm } from './AddWorkerForm';
import { RotateLinkButton } from './RotateLinkButton';

export const dynamic = 'force-dynamic';

/** `?error=<reason>` carries a rejection reason from src/admin/events.ts, never user input. */
const ERRORS: Record<string, string> = {
  'unknown-event': 'That event no longer exists.',
  'event-closed': 'This event is closed. Reopening is not supported — create a new event.',
  'unknown-customer': 'That customer is not in the synced QuickBooks data. Run Sync and retry.',
  'unknown-worker': 'That worker is no longer on this event.',
  'not-participating': 'That customer is not on this event.',
  'has-submissions': 'Parts have already been recorded — removing would destroy that history.',
  'has-batch': 'This customer has already been approved for invoicing.',
  'already-closed': 'This event was already closed.',
  'invalid-name': 'Pick someone from the list, or type a name.',
  'unposted-customers': 'Some customers have not been posted to QuickBooks yet — see below.',
  'invalid-dates': 'Give a start and end date, with the end on or after the start.',
};

const BATCH_LABEL: Record<string, string> = {
  APPROVED: 'Approved',
  POSTED: 'Posted',
  POST_FAILED: 'Post failed',
};

export default async function EventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdminPage();

  const eventId = Number((await params).eventId);
  if (!Number.isInteger(eventId)) notFound();
  const event = await getEvent(eventId);
  if (!event) notFound();

  const { error } = await searchParams;
  const [customers, pickable, workers, staff] = await Promise.all([
    listCustomers(eventId),
    availableCustomers(eventId),
    listWorkers(eventId),
    listStaff(),
  ]);

  const closed = event.closed_at !== null;
  const unposted = customers.filter((c) => c.batchStatus !== 'POSTED');

  return (
    <div className="admin-wrap">
      <div className="admin-bar">
        <h1>
          {event.code} — {event.name}{' '}
          {closed ? (
            <span className="admin-badge closed">Closed</span>
          ) : (
            <span className="admin-badge open">Open</span>
          )}
        </h1>
        <div className="admin-inline">
          <a className="admin-btn secondary" href="/admin">
            All events
          </a>
          <form method="post" action="/api/admin/logout">
            <button className="admin-btn secondary" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </div>

      {error && <div className="status-note error">{ERRORS[error] ?? error}</div>}
      {closed && (
        <p className="admin-note">
          This event is closed: every worker link was destroyed and no further changes are
          possible. History below is read-only.
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Dates are editable while the event is open because they set when every worker's
          link stops working (end date + one day). A weekend that runs long is fixed here —
          rotating a link cannot do it, since a new token inherits the same expiry. */}
      <h2 className="admin-h2">Dates</h2>
      {closed ? (
        <p className="admin-note">
          Ran {event.start_date} → {event.end_date}.
        </p>
      ) : (
        <form className="admin-card admin-inline" action={updateEventDatesAction}>
          <input type="hidden" name="eventId" value={event.id} />
          <div>
            <label className="admin-field" htmlFor="startDate">
              Starts
            </label>
            <input
              className="admin-input narrow"
              id="startDate"
              name="startDate"
              type="date"
              defaultValue={event.start_date}
              required
            />
          </div>
          <div>
            <label className="admin-field" htmlFor="endDate">
              Ends
            </label>
            <input
              className="admin-input narrow"
              id="endDate"
              name="endDate"
              type="date"
              defaultValue={event.end_date}
              required
            />
          </div>
          <div className="admin-grow">
            <p className="admin-muted">
              Worker links stop working at the end of the day after the event ends. Push the
              end date back to keep them alive; the event code never changes.
            </p>
          </div>
          <button className="admin-btn secondary" type="submit">
            Save dates
          </button>
        </form>
      )}

      {/* ---------------------------------------------------------------- */}
      <h2 className="admin-h2">Customers being billed</h2>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Recorded by</th>
            <th>Invoicing</th>
            <th className="num">Tabs</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.qboId}>
              <td>
                <a href={`/admin/events/${eventId}/customers/${encodeURIComponent(c.qboId)}`}>
                  {c.displayName}
                </a>
                {!c.active && <span className="admin-badge closed">inactive in QBO</span>}
              </td>
              <td>{c.workers.length ? c.workers.join(', ') : <span className="admin-muted">nobody yet</span>}</td>
              <td>
                {c.batchStatus ? (
                  <span className={`admin-badge ${c.batchStatus === 'POSTED' ? 'open' : 'closed'}`}>
                    {BATCH_LABEL[c.batchStatus]}
                  </span>
                ) : (
                  <span className="admin-muted">not approved</span>
                )}
              </td>
              <td className="num">{c.submissionCount}</td>
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
          ))}
          {customers.length === 0 && (
            <tr>
              <td className="empty-cell" colSpan={5}>
                No customers on this event yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {!closed && (
        <form className="admin-inline admin-addrow" action={addCustomerAction}>
          <input type="hidden" name="eventId" value={eventId} />
          <select className="admin-input" name="customerQboId" defaultValue="" required>
            <option value="" disabled>
              — add a synced customer —
            </option>
            {pickable.map((c) => (
              <option key={c.qboId} value={c.qboId}>
                {c.displayName}
              </option>
            ))}
          </select>
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

      {/* ---------------------------------------------------------------- */}
      <h2 className="admin-h2">Workers</h2>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Worker</th>
            <th>Language</th>
            <th>Assigned customers</th>
            <th>Link</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => {
            const unassigned = customers.filter((c) => !w.customers.includes(c.qboId));
            return (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td>{w.language === 'es' ? 'Español' : 'English'}</td>
                <td>
                  <ul className="admin-chips">
                    {w.customers.map((id) => {
                      const c = customers.find((x) => x.qboId === id);
                      return (
                        <li key={id}>
                          <span>{c?.displayName ?? id}</span>
                          {!closed && (
                            <form action={unassignAction}>
                              <input type="hidden" name="eventId" value={eventId} />
                              <input type="hidden" name="workerId" value={w.id} />
                              <input type="hidden" name="customerQboId" value={id} />
                              <button className="admin-chip-x" type="submit" title="Unassign">
                                ×
                              </button>
                            </form>
                          )}
                        </li>
                      );
                    })}
                    {w.customers.length === 0 && <li className="admin-muted">none</li>}
                  </ul>
                  {!closed && unassigned.length > 0 && (
                    <form className="admin-inline" action={assignAction}>
                      <input type="hidden" name="eventId" value={eventId} />
                      <input type="hidden" name="workerId" value={w.id} />
                      <select className="admin-input small" name="customerQboId" defaultValue="" required>
                        <option value="" disabled>
                          — assign —
                        </option>
                        {unassigned.map((c) => (
                          <option key={c.qboId} value={c.qboId}>
                            {c.displayName}
                          </option>
                        ))}
                      </select>
                      <button className="admin-btn small" type="submit">
                        Assign
                      </button>
                    </form>
                  )}
                </td>
                <td>
                  {w.hasToken ? (
                    <span className="admin-badge open">active</span>
                  ) : (
                    <span className="admin-badge closed">
                      {w.tokenRevokedAt ? 'destroyed' : 'none'}
                    </span>
                  )}
                  {!closed && (
                    <RotateLinkButton eventId={eventId} workerId={w.id} workerName={w.name} />
                  )}
                </td>
                <td className="num">
                  {!closed && (
                    <form action={removeWorkerAction}>
                      <input type="hidden" name="eventId" value={eventId} />
                      <input type="hidden" name="workerId" value={w.id} />
                      <button
                        className="admin-btn small secondary"
                        type="submit"
                        disabled={w.submissionCount > 0}
                        title={
                          w.submissionCount > 0
                            ? 'Has recorded parts — rotate the link instead'
                            : undefined
                        }
                      >
                        Remove
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
          {workers.length === 0 && (
            <tr>
              <td className="empty-cell" colSpan={5}>
                No workers on this event yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {!closed && (
        <div className="admin-card admin-addrow">
          <AddWorkerForm eventId={eventId} staff={staff} />
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {!closed && (
        <>
          <h2 className="admin-h2">Close the event</h2>
          <div className="admin-card">
            <p className="admin-note">
              Closing destroys every worker link and stops all entry. Do it once every customer
              has been posted to QuickBooks.
            </p>
            {error === 'unposted-customers' ? (
              <>
                <div className="status-note error">
                  Not posted yet:{' '}
                  {unposted.map((c) => `${c.displayName} (${BATCH_LABEL[c.batchStatus ?? ''] ?? 'not approved'})`).join(', ')}
                </div>
                <form action={closeEventAction}>
                  <input type="hidden" name="eventId" value={eventId} />
                  <input type="hidden" name="force" value="1" />
                  {/* `required` on an unchecked box is the no-JS confirm dialog. */}
                  <label className="admin-confirm">
                    <input type="checkbox" required /> I understand these customers will not be
                    invoiced from this app.
                  </label>
                  <button className="admin-btn danger" type="submit">
                    Close anyway — {unposted.length} customer(s) will never be invoiced from here
                  </button>
                </form>
              </>
            ) : (
              <form action={closeEventAction}>
                <input type="hidden" name="eventId" value={eventId} />
                <label className="admin-confirm">
                  <input type="checkbox" required /> I understand every worker link is destroyed
                  and cannot be restored.
                </label>
                <button className="admin-btn danger" type="submit">
                  Close event &amp; destroy {workers.filter((w) => w.hasToken).length} worker link(s)
                </button>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
