// Admin home: every event, its setup state, and the create-event form (plan §7).
//
// The create form is a plain `<form method="post">` to app/api/admin/events/route.ts, in the
// same no-JS style as the login page — there is nothing secret in that response, so a 303
// back to the new event is fine. (The event detail page uses Server Actions instead; see
// app/admin/events/[eventId]/actions.ts for why.)
import { requireAdminPage } from '@/src/admin-page-auth';
import { listEvents } from '@/src/admin/events';
import { SyncButton } from './SyncButton';

export const dynamic = 'force-dynamic';

/** `?error=<reason>` from the create-event route — enum-ish reasons, never user input. */
const ERRORS: Record<string, string> = {
  'invalid-code': 'Event codes are 1–8 characters, letters and digits only (e.g. R8, SPRING26).',
  'invalid-name': 'Give the event a name.',
  'duplicate-code': 'An event with that code already exists — open it below.',
  // Where a manager lands if they try /admin/admins directly.
  'owner-only': 'Only the owner can manage accounts.',
};

export default async function AdminHomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const me = await requireAdminPage();

  const [events, { error }] = await Promise.all([listEvents(), searchParams]);

  return (
    <div className="admin-wrap">
      <div className="admin-bar">
        <h1>Events</h1>
        <div className="admin-inline">
          <SyncButton />
          <a className="admin-btn secondary" href="/admin/usage">
            Parts usage
          </a>
          {/* Owner-only in the nav as well as in the guard: a manager should not be invited
              to click something that will bounce them. */}
          {me.role === 'owner' && (
            <a className="admin-btn secondary" href="/admin/admins">
              Accounts
            </a>
          )}
          <a className="admin-btn secondary" href="/admin/account">
            {me.name}
          </a>
          <form method="post" action="/api/admin/logout">
            <button className="admin-btn secondary" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </div>

      {error && <div className="status-note error">{ERRORS[error] ?? error}</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Event</th>
            <th>Status</th>
            <th className="num">Customers</th>
            <th className="num">Workers</th>
            <th>Invoicing</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>
                <a href={`/admin/events/${e.id}`}>{e.code}</a>
              </td>
              <td>{e.name}</td>
              <td>
                {e.closed_at ? (
                  <span className="admin-badge closed">Closed</span>
                ) : (
                  <span className="admin-badge open">Open</span>
                )}
              </td>
              <td className="num">{e.customerCount}</td>
              <td className="num">{e.workerCount}</td>
              <td>
                {e.customerCount === 0 ? (
                  <span className="admin-muted">nothing to bill yet</span>
                ) : (
                  // Read as a funnel: still open for entry → approved, waiting to post →
                  // posted → failed and needing a retry.
                  [
                    e.openCount ? `${e.openCount} open` : null,
                    e.approvedCount ? `${e.approvedCount} approved` : null,
                    e.postedCount ? `${e.postedCount} posted` : null,
                    e.failedCount ? `${e.failedCount} failed` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                )}
              </td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td className="empty-cell" colSpan={6}>
                No events yet — create the first one below.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2 className="admin-h2">New event</h2>
      <form className="admin-card admin-inline" method="post" action="/api/admin/events">
        <div>
          <label className="admin-field" htmlFor="code">
            Code
          </label>
          <input
            className="admin-input narrow mono"
            id="code"
            name="code"
            // Mirrors EVENT_CODE_RE in src/admin/events.ts and the CHECK in db/schema.sql:
            // the code becomes part of a 21-character QuickBooks DocNumber.
            pattern="[A-Za-z0-9]{1,8}"
            maxLength={8}
            placeholder="R8"
            autoComplete="off"
            required
          />
        </div>
        <div className="admin-grow">
          <label className="admin-field" htmlFor="name">
            Name
          </label>
          <input
            className="admin-input"
            id="name"
            name="name"
            placeholder="Round 8 — Laguna Seca"
            autoComplete="off"
            required
          />
        </div>
        <button className="admin-btn" type="submit">
          Create event
        </button>
      </form>
    </div>
  );
}
