// M1 escape hatch: CSV export of all submitted usage, for manual bookkeeping
// until M2's Approve & Post exists. Accepts the admin cookie or `?secret=`
// (scripts) — see src/admin-auth.ts.
import { NextRequest } from 'next/server';
import { q } from '@/src/db';
import { requireAdmin } from '@/src/admin-auth';

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  // voided_at IS NULL: void'd lines were entry mistakes, not usage — keep them out of billing.
  // Manager adjustments are lines on the event's synthetic admin worker; the `worker` column
  // reads "Manager" for those. Columns are otherwise unchanged — downstream sheets depend
  // on this header.
  const rows = await q(
    `SELECT e.code AS event, c.display_name AS customer,
            CASE WHEN w.is_admin THEN 'Manager' ELSE w.name END AS worker,
            l.sku, l.item_name, l.qty, l.unit_price, s.status, s.submitted_at, s.id AS submission_id
     FROM submission_lines l
     JOIN submissions s ON s.id = l.submission_id
     JOIN events e ON e.id = s.event_id
     JOIN workers w ON w.id = s.worker_id
     JOIN customers c ON c.qbo_id = s.customer_qbo_id
     WHERE l.voided_at IS NULL
     ORDER BY e.code, c.display_name, s.submitted_at`
  );

  const header = 'event,customer,worker,sku,item_name,qty,unit_price,status,submitted_at,submission_id';
  const body = rows.map((r: any) =>
    [r.event, r.customer, r.worker, r.sku, r.item_name, r.qty, r.unit_price, r.status, r.submitted_at?.toISOString?.() ?? r.submitted_at, r.submission_id]
      .map(csvCell)
      .join(',')
  );

  return new Response([header, ...body].join('\n') + '\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="parts-usage.csv"',
    },
  });
}
