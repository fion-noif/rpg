// The Customers / Workers switcher.
//
// Plain <a> links over a `?tab=` param rather than client state, for a reason specific to
// this page: every non-link mutation ends in a redirect (`finish()` in ./actions.ts), which
// is a full navigation and would wipe client tab state — so unassigning a customer from the
// Workers tab would answer by throwing you back to Customers. The URL is the only place tab
// state survives a redirect. It also makes a tab deep-linkable and works with JS off.
//
// `customers` is the default and is never written into the URL, so a plain
// /admin/events/3 stays plain.
import type { Tab } from './types';

export function EventTabs({
  eventId,
  tab,
  counts,
}: {
  eventId: number;
  tab: Tab;
  counts: { customers: number; workers: number };
}) {
  const base = `/admin/events/${eventId}`;
  return (
    <nav className="admin-tabs" aria-label="Event sections">
      <a href={base} aria-current={tab === 'customers' ? 'page' : undefined}>
        Customers <span className="count">{counts.customers}</span>
      </a>
      <a href={`${base}?tab=workers`} aria-current={tab === 'workers' ? 'page' : undefined}>
        Workers <span className="count">{counts.workers}</span>
      </a>
    </nav>
  );
}
