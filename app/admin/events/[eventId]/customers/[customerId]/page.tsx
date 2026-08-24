// Per-customer review (design doc §17, plan §7): everything charged to one customer at one
// event, in one list, with who recorded it — the manager reviews a customer, not dozens of
// isolated transactions.
//
// Server Component / Client Component split mirrors app/page.tsx → app/WorkerApp.tsx: this
// file does auth + the reads, CustomerReview.tsx owns the edit interactions.
import { notFound } from 'next/navigation';
import { q } from '@/src/db';
import { requireAdminPage } from '@/src/admin-page-auth';
import CustomerReview, { type CatalogOption, type ReviewLine } from './CustomerReview';

export const dynamic = 'force-dynamic';

interface LineRow {
  id: number;
  item_id: string;
  sku: string | null;
  item_name: string;
  unit_price: number | null;
  qty: number;
  updated_at: string;
  voided_at: string | null;
  worker_name: string;
  is_admin: boolean;
  voided_by_name: string | null;
  voided_by_is_admin: boolean | null;
}

/** "Manager" for the event's synthetic admin worker; the stored name is the fallback. */
function submitter(name: string | null, isAdmin: boolean | null): string {
  if (isAdmin) return 'Manager';
  return name ?? 'unknown';
}

export default async function CustomerReviewPage({
  params,
}: {
  params: Promise<{ eventId: string; customerId: string }>;
}) {
  await requireAdminPage();

  const { eventId: eventIdParam, customerId } = await params;
  const eventId = Number(eventIdParam);
  if (!Number.isInteger(eventId)) notFound();

  // One query for the header: the customer must actually participate in this event
  // (design doc §21), so a hand-typed URL for a non-participating customer 404s rather
  // than rendering an empty review that the manager might mistake for "nothing used".
  const [header] = await q<{ code: string; event_name: string; customer: string; closed_at: string | null }>(
    `SELECT e.code, e.name AS event_name, c.display_name AS customer, e.closed_at
     FROM event_customers ec
     JOIN events e ON e.id = ec.event_id
     JOIN customers c ON c.qbo_id = ec.customer_qbo_id
     WHERE ec.event_id = $1 AND ec.customer_qbo_id = $2`,
    [eventId, customerId]
  );
  if (!header) notFound();

  // Voided lines are read too, not filtered out: §17 wants the manager to be able to see
  // what was changed and by whom, so they render in a collapsed audit section.
  const rows = await q<LineRow>(
    `SELECT l.id, l.item_qbo_id AS item_id, l.sku, l.item_name, l.unit_price::float AS unit_price,
            l.qty::float AS qty, l.updated_at, l.voided_at,
            w.name AS worker_name, w.is_admin,
            vb.name AS voided_by_name, vb.is_admin AS voided_by_is_admin
     FROM submission_lines l
     JOIN submissions s ON s.id = l.submission_id
     JOIN workers w ON w.id = s.worker_id
     LEFT JOIN workers vb ON vb.id = l.voided_by
     WHERE s.event_id = $1 AND s.customer_qbo_id = $2
     ORDER BY l.item_name, l.id`,
    [eventId, customerId]
  );

  const lines: ReviewLine[] = rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    sku: r.sku,
    itemName: r.item_name,
    unitPrice: r.unit_price,
    qty: r.qty,
    updatedAt: new Date(r.updated_at).toISOString(),
    voided: r.voided_at != null,
    submittedBy: submitter(r.worker_name, r.is_admin),
    voidedBy: r.voided_at ? submitter(r.voided_by_name, r.voided_by_is_admin) : null,
  }));

  // Same catalogue shape and filter as app/page.tsx: only what QuickBooks still sells is
  // addable (design doc §9, §23 Rule 3).
  const catalog = await q<CatalogOption>(
    `SELECT qbo_id AS id, sku, name, description, unit_price::float AS price
     FROM items
     WHERE active AND type IN ('NonInventory', 'Service', 'Inventory')
     ORDER BY name`
  );

  // Approval closes the customer to any further change, worker or manager (plan §3). The
  // Approve & Post button itself is a later step; this is only the read-only signal.
  const [batch] = await q<{ status: string }>(
    `SELECT status FROM charge_batches WHERE event_id = $1 AND customer_qbo_id = $2`,
    [eventId, customerId]
  );

  return (
    <div className="admin-wrap">
      <div className="admin-bar">
        <h1>
          {header.customer} — {header.code}
        </h1>
        <a className="admin-btn secondary" href={`/admin/events/${eventId}`}>
          Back to event
        </a>
      </div>
      <p className="admin-note">
        {header.event_name}
        {header.closed_at ? ' · event closed' : ''}
      </p>

      <CustomerReview
        eventId={eventId}
        customerId={customerId}
        lines={lines}
        catalog={catalog}
        batchStatus={batch?.status ?? null}
      />
    </div>
  );
}
