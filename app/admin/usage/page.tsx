// Read-only manager view so usage can be checked mid-weekend without a CSV download.
// Guarded by the same shared-secret pattern as app/api/admin/export/route.ts. No edit,
// approve, or post actions here — that's M2 (design doc §17).
import { timingSafeEqual } from 'node:crypto';
import { q } from '@/src/db';
import { config } from '@/src/config';

export const dynamic = 'force-dynamic';

function isAuthorized(provided: string | undefined): boolean {
  const expected = Buffer.from(config.adminSecret);
  const actual = Buffer.from(provided ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface Row {
  event_code: string;
  customer: string;
  item_name: string;
  sku: string | null;
  qty: number;
  workers: string;
  last_updated: string;
}

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ secret?: string }>;
}) {
  const { secret } = await searchParams;
  if (!isAuthorized(secret)) {
    return <div style={{ padding: 24, fontFamily: 'sans-serif' }}>Forbidden.</div>;
  }

  // voided_at IS NULL: removed entries are entry mistakes, not usage.
  const rows = await q<Row>(
    `SELECT e.code AS event_code, c.display_name AS customer, l.item_name, l.sku,
            SUM(l.qty)::float AS qty, string_agg(DISTINCT w.name, ', ') AS workers,
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
    <div style={{ padding: 24, fontFamily: '-apple-system, sans-serif', maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20 }}>Parts usage — read-only</h1>
      <p style={{ color: '#71717a', fontSize: 13 }}>
        Live totals for active events. Removed entries are excluded. Read-only — approval and
        posting to QuickBooks is a later milestone.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #d4d4d8' }}>
            <th style={{ padding: '6px 8px' }}>Event</th>
            <th style={{ padding: '6px 8px' }}>Customer</th>
            <th style={{ padding: '6px 8px' }}>Part</th>
            <th style={{ padding: '6px 8px' }}>SKU</th>
            <th style={{ padding: '6px 8px', textAlign: 'right' }}>Qty</th>
            <th style={{ padding: '6px 8px' }}>Recorded by</th>
            <th style={{ padding: '6px 8px' }}>Last updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #e4e4e7' }}>
              <td style={{ padding: '6px 8px' }}>{r.event_code}</td>
              <td style={{ padding: '6px 8px' }}>{r.customer}</td>
              <td style={{ padding: '6px 8px' }}>{r.item_name}</td>
              <td style={{ padding: '6px 8px' }}>{r.sku ?? ''}</td>
              <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.qty}</td>
              <td style={{ padding: '6px 8px' }}>{r.workers}</td>
              <td style={{ padding: '6px 8px' }}>{new Date(r.last_updated).toLocaleString()}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} style={{ padding: '16px 8px', color: '#a1a1aa' }}>
                No usage recorded yet for any active event.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
