// Event detail: who is billed, who is recording, and who can see what (plan §7).
//
// Thin controller. Every read is one call into src/admin/events.ts, every write is a Server
// Action in ./actions.ts (that file explains why actions rather than route handlers here),
// and the markup lives in the four components below.
//
// The page is two tabs over a persistent header. It used to be one 392-line scroll —
// dates, customers, workers, close-event — which stopped working somewhere around a dozen
// customers, because the customers table and the workers table are the two things a manager
// alternates between during setup and they were a full page apart. Setup is now
// customer-first on the Customers tab (see ./CustomersTable.tsx); Workers is the surface you
// visit to rotate a lost link; closing has its own page under ./close.
import { notFound } from 'next/navigation';
import { requireAdminPage } from '@/src/admin-page-auth';
import { availableCustomers, getEvent, listCustomers, listWorkers } from '@/src/admin/events';
import { listStaff } from '@/src/admin/staff';
import { EventHeader } from './EventHeader';
import { EventTabs } from './EventTabs';
import { CustomersTable } from './CustomersTable';
import { WorkersTab } from './WorkersTab';
import type { AssignableWorker } from './AssignPanel';
import type { Tab } from './types';

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
  'invalid-dates': 'Give a start and end date, with the end on or after the start.',
};

export default async function EventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  /** `tab` is typed loosely and narrowed below — it comes from the URL, so it must never be
   *  typed as the union it is checked against. */
  searchParams: Promise<{ error?: string; tab?: string }>;
}) {
  await requireAdminPage();

  const eventId = Number((await params).eventId);
  if (!Number.isInteger(eventId)) notFound();
  const event = await getEvent(eventId);
  if (!event) notFound();

  const { error, tab: rawTab } = await searchParams;
  const tab: Tab = rawTab === 'workers' ? 'workers' : 'customers';

  // Both tabs need customers *and* workers — the customers tab builds its assign pickers
  // from the workers, the workers tab renders customer display names — so this stays one
  // batch rather than being split per tab.
  const [customers, pickable, workers, staff] = await Promise.all([
    listCustomers(eventId),
    availableCustomers(eventId),
    listWorkers(eventId),
    listStaff(),
  ]);

  const closed = event.closed_at !== null;

  // Who is still assignable to each customer, by worker *id*. Computed here rather than in
  // the client component because `EventCustomer.workers` is an array of names, and names are
  // not identity in this app (§23 Rule 1) — filtering by name would hide two same-named
  // people together. `EventWorker.customers` carries qboIds, which are.
  const assignableByCustomer: Record<string, AssignableWorker[]> = {};
  for (const c of customers) {
    assignableByCustomer[c.qboId] = workers
      .filter((w) => !w.customers.includes(c.qboId))
      .map((w) => ({ id: w.id, name: w.name }));
  }

  return (
    <div className="admin-wrap">
      <EventHeader event={event} closed={closed} tab={tab} />

      {error && <div className="status-note error">{ERRORS[error] ?? error}</div>}
      {closed && (
        <p className="admin-note">
          This event is closed: every worker link was destroyed and no further changes are
          possible. Everything below is read-only.
        </p>
      )}

      <EventTabs
        eventId={eventId}
        tab={tab}
        counts={{ customers: customers.length, workers: workers.length }}
      />

      {tab === 'customers' ? (
        <CustomersTable
          eventId={eventId}
          closed={closed}
          customers={customers.map((c) => ({
            qboId: c.qboId,
            displayName: c.displayName,
            active: c.active,
            workers: c.workers,
            batchStatus: c.batchStatus,
          }))}
          pickable={pickable}
          assignableByCustomer={assignableByCustomer}
          staff={staff}
        />
      ) : (
        <WorkersTab
          eventId={eventId}
          closed={closed}
          workers={workers}
          customers={customers}
          staff={staff}
        />
      )}
    </div>
  );
}
