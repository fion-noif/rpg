import { cookies } from 'next/headers';
import { q } from '@/src/db';
import { workerByToken, assignmentsFor, SESSION_COOKIE } from '@/src/workers';
import { usageForCustomer, type UsageLine } from '@/src/usage';
import { strings } from '@/src/i18n';
import WorkerApp, { type CatalogItem } from './WorkerApp';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const worker = await workerByToken(token);

  if (!worker) {
    return (
      <div className="center-msg">
        <p>{strings.en.noSession}</p>
        <p lang="es">{strings.es.noSession}</p>
      </div>
    );
  }

  const customers = await assignmentsFor(worker.id);

  const catalog = await q<CatalogItem>(
    `SELECT qbo_id AS id, sku, name, description, unit_price::float AS price, category
     FROM items
     WHERE active AND type IN ('NonInventory', 'Service', 'Inventory')
     ORDER BY name`
  );

  // Popular = most-used items for this event; empty until usage accumulates (M3 refines this).
  const popular = await q<{ id: string }>(
    `SELECT l.item_qbo_id AS id
     FROM submission_lines l JOIN submissions s ON s.id = l.submission_id
     WHERE s.event_id = $1 AND l.voided_at IS NULL
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
