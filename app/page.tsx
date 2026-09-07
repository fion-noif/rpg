import { cookies } from 'next/headers';
import { q } from '@/src/db';
import { resolveToken, assignmentsFor, SESSION_COOKIE } from '@/src/workers';
import { usageForCustomer, type UsageLine } from '@/src/usage';
import { strings } from '@/src/i18n';
import { workerVisibleItemSql } from '@/src/catalog';
import WorkerApp, { type CatalogItem } from './WorkerApp';

export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  /** `?link=expired|unknown` from app/login/[token]/route.ts on a failed login. */
  searchParams: Promise<{ link?: string }>;
}) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const [resolution, { link }] = await Promise.all([resolveToken(token), searchParams]);

  if (!resolution.ok) {
    // Two sources for the same verdict: an expired *cookie* is diagnosed here, while an
    // expired *link* was diagnosed by the login route (which set no cookie, so there is
    // nothing left here to inspect) and forwarded as `?link=`. Either is enough.
    const expired = resolution.reason === 'expired' || link === 'expired';
    const message = expired ? 'linkExpired' : 'noSession';
    // Both languages, always: the worker who cannot get in is exactly the worker whose
    // language preference we can no longer read.
    return (
      <div className="center-msg">
        <p>{strings.en[message]}</p>
        <p lang="es">{strings.es[message]}</p>
      </div>
    );
  }
  const worker = resolution.worker;

  const customers = await assignmentsFor(worker.id);

  // Physical parts only. Service items (`Race Services`) are manager-only — a worker records
  // what they fitted to a kart, not how many days of mechanic time to bill (§8 least
  // privilege). The rule lives in src/catalog.ts; before it, the bare
  // `type IN ('NonInventory','Service','Inventory')` filter here is what put Intuit's stock
  // `Services` and `Hours` items on every worker's phone.
  const catalog = await q<CatalogItem>(
    `SELECT qbo_id AS id, sku, name, description, unit_price::float AS price, category
     FROM items
     WHERE ${workerVisibleItemSql()}
     ORDER BY name`
  );

  // Popular = most-used items for this event; empty until usage accumulates (M3 refines this).
  //
  // Filtered through the same predicate, not just ranked: a *manager* can add a service line
  // during review (§17) and that line is real usage, so without the join a heavily-serviced
  // event would surface "Mechanic (per day)" in the worker's popular strip — the one place a
  // hidden item could still reach a worker's thumb.
  const popular = await q<{ id: string }>(
    `SELECT l.item_qbo_id AS id
     FROM submission_lines l
     JOIN submissions s ON s.id = l.submission_id
     JOIN items i ON i.qbo_id = l.item_qbo_id
     WHERE s.event_id = $1 AND l.voided_at IS NULL AND ${workerVisibleItemSql('i')}
     GROUP BY l.item_qbo_id ORDER BY SUM(l.qty) DESC LIMIT 5`,
    [worker.event_id]
  );

  // Hydrate the usage list so the page renders with real data and survives a reload with
  // no client fetch. Keyed by customer so switching tabs can read from this map first.
  const usageByCustomer: Record<string, UsageLine[]> = {};
  for (const c of customers) {
    usageByCustomer[c.qbo_id] = await usageForCustomer(worker.event_id, c.qbo_id);
  }

  // A charge batch existing for (event, customer) is exactly what `setUsageQty` rejects as
  // 'tab-locked' (src/usage.ts `lockParticipation`), so render those customers read-only
  // rather than accepting taps that the server will refuse with a 409.
  const batches = await q<{ customer_qbo_id: string }>(
    `SELECT customer_qbo_id FROM charge_batches WHERE event_id = $1`,
    [worker.event_id]
  );
  const locked = new Set(batches.map((b) => b.customer_qbo_id));
  const lockedByCustomer: Record<string, boolean> = {};
  for (const c of customers) lockedByCustomer[c.qbo_id] = locked.has(c.qbo_id);

  return (
    <WorkerApp
      worker={{ id: worker.id, name: worker.name, language: worker.language, eventName: worker.event_name }}
      customers={customers}
      catalog={catalog}
      popularIds={popular.map((p) => p.id)}
      usageByCustomer={usageByCustomer}
      lockedByCustomer={lockedByCustomer}
    />
  );
}
