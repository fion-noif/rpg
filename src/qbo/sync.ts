// Manual-only master-data sync (design doc §19, revised 08/09/2026):
// invoked from the CLI (`npm run sync`) or the admin HTTP endpoint — never on a schedule.
import { q, pool } from '../db';
import { queryAll, companyInfo } from './client';

export interface SyncResult {
  company: string;
  customers: number;
  items: number;
}

export async function syncFromQuickBooks(): Promise<SyncResult> {
  const company = await companyInfo();

  // Include inactive records so status changes are visible (design doc §23 Rule 3).
  const customers = await queryAll('Customer', 'Active in (true, false)');
  const items = await queryAll('Item', 'Active in (true, false)');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of customers) {
      await client.query(
        `INSERT INTO customers (qbo_id, display_name, active, sync_token, raw, synced_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (qbo_id) DO UPDATE SET
           display_name = $2, active = $3, sync_token = $4, raw = $5, synced_at = now()`,
        [c.Id, c.DisplayName, !!c.Active, c.SyncToken, JSON.stringify(c)]
      );
    }
    for (const i of items) {
      await client.query(
        `INSERT INTO items (qbo_id, sku, name, description, unit_price, type, category, active, sync_token, raw, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (qbo_id) DO UPDATE SET
           sku = $2, name = $3, description = $4, unit_price = $5, type = $6,
           category = $7, active = $8, sync_token = $9, raw = $10, synced_at = now()`,
        [
          i.Id, i.Sku ?? null, i.Name, i.Description ?? null, i.UnitPrice ?? null,
          i.Type ?? null, i.ParentRef?.name ?? null, !!i.Active, i.SyncToken, JSON.stringify(i),
        ]
      );
    }
    for (const entity of ['Customer', 'Item']) {
      await client.query(
        `INSERT INTO sync_state (entity, last_synced_at) VALUES ($1, now())
         ON CONFLICT (entity) DO UPDATE SET last_synced_at = now()`,
        [entity]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { company: company?.CompanyName ?? 'unknown', customers: customers.length, items: items.length };
}
