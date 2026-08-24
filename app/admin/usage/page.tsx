// Read-only manager view so usage can be checked mid-weekend without a CSV download.
// Cookie-only (see src/admin-page-auth.ts) — the old `?secret=` URL now redirects
// through /admin/login. No edit, approve, or post actions here — that's M2 (§17).
import { q } from '@/src/db';
import { requireAdminPage } from '@/src/admin-page-auth';

export const dynamic = 'force-dynamic';

interface Row {
  event_code: string;
  customer: string;
  item_name: string;
  sku: string | null;
  qty: number;
  workers: string;
  last_updated: string;
}

export default async function AdminUsagePage() {
  await requireAdminPage();

  // voided_at IS NULL: removed entries are entry mistakes, not usage.
  // Manager adjustments live on the event's synthetic admin worker (`w.is_admin`), so they
  // are attributed to "Manager" rather than to whatever that row happens to be named.
  const rows = await q<Row>(
    `SELECT e.code AS event_code, c.display_name AS customer, l.item_name, l.sku,
            SUM(l.qty)::float AS qty,
            string_agg(DISTINCT CASE WHEN w.is_admin THEN 'Manager' ELSE w.name END, ', ') AS workers,
            MAX(l.updated_at) AS last_updated
     FROM submission_lines l
     JOIN submissions s ON s.id = l.submission_id
     JOIN events e ON e.id = s.event_id
     JOIN customers c ON c.qbo_id = s.customer_qbo_id
     JOIN workers w ON w.id = s.worker_id
     WHERE l.voided_at IS NULL AND e.active
     GROUP BY e.code, c.display_name, l.item_name, l.sku
     ORDER BY e.code, c.display_name, l.item_name`
  );

  return (
    <div className="admin-wrap">
      <div className="admin-bar">
        <h1>Parts usage — read-only</h1>
        <a className="admin-btn secondary" href="/admin">
          Back to admin
        </a>
      </div>
      <p className="admin-note">
        Live totals for active events. Removed entries are excluded. Read-only — approval and
        posting to QuickBooks is a later milestone.
      </p>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Event</th>
            <th>Customer</th>
            <th>Part</th>
            <th>SKU</th>
            <th className="num">Qty</th>
            <th>Recorded by</th>
            <th>Last updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.event_code}</td>
              <td>{r.customer}</td>
              <td>{r.item_name}</td>
              <td>{r.sku ?? ''}</td>
              <td className="num">{r.qty}</td>
              <td>{r.workers}</td>
              <td>{new Date(r.last_updated).toLocaleString()}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-cell" colSpan={7}>
                No usage recorded yet for any active event.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
