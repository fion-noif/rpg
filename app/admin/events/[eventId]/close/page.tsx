// Closing a weekend: the confirmation, on its own page.
//
// This used to be a section at the bottom of the event detail page, which put a destructive
// irreversible action in the same scroll as everyday setup. It is also rare — once per
// weekend — so it earns a button and a page rather than permanent screen space.
//
// The old flow needed two submits: you closed, got refused because customers were unposted,
// and the page re-rendered with a second "close anyway" form. That existed only because the
// customers area could not afford to list the blockers unprompted. A dedicated page can, so
// this asks once, with the blockers already on screen.
import { notFound } from 'next/navigation';
import { requireAdminPage } from '@/src/admin-page-auth';
import { getEvent, listUnposted, listWorkers } from '@/src/admin/events';
import { closeEventAction } from '../actions';
import { BATCH_LABEL } from '../types';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  // Reachable only as a race now: the form submits `force` whenever blockers are on screen,
  // so seeing this means the batches changed between render and submit.
  'unposted-customers':
    'Someone changed a batch while you were on this page — the list below is current. Try again.',
  'already-closed': 'This event was already closed.',
};

export default async function CloseEventPage({
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
  // The same query `closeEvent`'s guard runs (src/admin/events.ts `unpostedRows`), not a
  // re-derivation of it: the explanation and the rule must not be able to disagree.
  const [unposted, workers] = await Promise.all([listUnposted(eventId), listWorkers(eventId)]);
  const closed = event.closed_at !== null;
  const liveLinks = workers.filter((w) => w.hasToken).length;

  return (
    <div className="admin-wrap narrow">
      <h1>Close {event.name}?</h1>

      {error && <div className="status-note error">{ERRORS[error] ?? error}</div>}

      {closed ? (
        <>
          <p className="admin-note">
            Already closed. It ran {event.start_date} → {event.end_date}, and every worker link
            was destroyed. Reopening is not supported — create a new event.
          </p>
          <a className="admin-btn secondary" href={`/admin/events/${eventId}`}>
            Back to the event
          </a>
        </>
      ) : (
        <>
          <p className="admin-note">
            Closing ends the weekend. It destroys every worker link — they are deleted, not
            just ignored — and makes the event unbillable from this app. It cannot be undone.
          </p>

          {unposted.length > 0 && (
            <>
              <h2 className="admin-h2">Not posted to QuickBooks yet</h2>
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Invoicing</th>
                  </tr>
                </thead>
                <tbody>
                  {unposted.map((c) => (
                    <tr key={c.qboId}>
                      <td>{c.displayName}</td>
                      <td>
                        <span className="admin-badge closed">
                          {BATCH_LABEL[c.status] ?? 'Not approved'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <form className="admin-card admin-addrow" action={closeEventAction}>
            <input type="hidden" name="eventId" value={eventId} />
            {/* Blockers on screen means the manager is overriding the all-POSTED guard, so
                the submit carries `force`. closeEvent records the override under their name,
                so it is never invisible. The server guard stays as it is — this page must
                not be the only thing enforcing it. */}
            {unposted.length > 0 && <input type="hidden" name="force" value="1" />}

            {/* `required` on an unchecked box is the no-JS confirm dialog. */}
            <label className="admin-confirm">
              <input type="checkbox" required />{' '}
              {unposted.length > 0
                ? `I understand these ${unposted.length} customer(s) will never be invoiced from this app, and that this override is recorded in the audit log.`
                : 'I understand every worker link is destroyed and cannot be restored.'}
            </label>

            <div className="admin-inline">
              <button className="admin-btn danger" type="submit">
                {unposted.length > 0
                  ? 'Close anyway'
                  : `Close event & destroy ${liveLinks} worker link${liveLinks === 1 ? '' : 's'}`}
              </button>
              <a className="admin-btn secondary" href={`/admin/events/${eventId}`}>
                Cancel
              </a>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
