// The Workers tab: who is on the weekend, what they can see, and their credential.
//
// The infrequent surface. Setup happens customer-first on the Customers tab; you come here
// to rotate a link somebody lost, to check whether a link is still live, or to give one
// worker several more customers at once — which is what the per-row assign picker below is
// for, and why it stays even though the Customers tab can also assign.
//
// It is also the no-JS floor: that picker is a plain Server Action form, so an admin with
// JavaScript off can still assign from here.
//
// Server component — every control is a form or a small client component of its own.
import { assignAction, removeWorkerAction, unassignAction } from './actions';
import { AddWorkerForm } from './AddWorkerForm';
import { RotateLinkButton } from './RotateLinkButton';
import type { EventCustomer, EventWorker } from '@/src/admin/events';
import type { StaffOption } from './types';

export function WorkersTab({
  eventId,
  closed,
  workers,
  customers,
  staff,
}: {
  eventId: number;
  closed: boolean;
  workers: EventWorker[];
  customers: EventCustomer[];
  staff: StaffOption[];
}) {
  return (
    <>
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
                              {/* Every form on this tab carries it, so the redirect comes
                                  back here instead of to Customers. */}
                              <input type="hidden" name="tab" value="workers" />
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
                      <input type="hidden" name="tab" value="workers" />
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
                      <input type="hidden" name="tab" value="workers" />
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
                No workers on this event yet. Add one while assigning a customer, or below.
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
    </>
  );
}
