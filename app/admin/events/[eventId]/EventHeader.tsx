// The event-level strip that persists across both tabs: what this weekend is, when it runs,
// and the one destructive thing you can do to it.
//
// Dates live here rather than on a tab because they are not a customers-or-workers concern —
// they set when every worker's link stops working (end date + one day), so a manager fixing
// a weekend that overran needs them reachable from wherever they are. Rotating a link cannot
// do that job: a new token re-derives the same dead expiry (src/workers.ts).
//
// Server component: every control is a link or a Server Action form, so none of it needs JS.
import { updateEventDatesAction } from './actions';
import type { EventDetail } from '@/src/admin/events';
import type { Tab } from './types';

export function EventHeader({
  event,
  closed,
  tab,
}: {
  event: EventDetail;
  closed: boolean;
  tab: Tab;
}) {
  return (
    <>
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
          {/* A link, not a form: closing is a navigation to a confirmation page, and this
              way it works with JS off and can be opened in a new tab. */}
          {!closed && (
            <a className="admin-btn danger" href={`/admin/events/${event.id}/close`}>
              Close event
            </a>
          )}
          <form method="post" action="/api/admin/logout">
            <button className="admin-btn secondary" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </div>

      <div className="admin-eventhead">
        <span className="dates">
          {event.start_date === event.end_date
            ? event.start_date
            : `${event.start_date} → ${event.end_date}`}
        </span>
        {closed ? (
          <span className="admin-muted">closed — dates are history now</span>
        ) : (
          // Collapsed by default: the dates are usually just reference, and the editor is
          // only wanted on the rare weekend that ran long. <details> keeps that native and
          // JS-free.
          <details className="admin-datesedit">
            <summary>Edit dates</summary>
            <form className="admin-inline" action={updateEventDatesAction}>
              <input type="hidden" name="eventId" value={event.id} />
              {/* The header spans both tabs, so a save has to return you to the one you
                  were on. */}
              <input type="hidden" name="tab" value={tab} />
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
              <button className="admin-btn secondary small" type="submit">
                Save dates
              </button>
              <p className="admin-note inline">
                Worker links stop working at the end of the day after the event ends. Push the
                end date back to keep them alive; the event code never changes.
              </p>
            </form>
          </details>
        )}
      </div>
    </>
  );
}
