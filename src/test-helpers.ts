// Shared setup for integration tests that run against a real Postgres instance. Tests import
// `pool` from ./db exactly like the app does; the "test" script in package.json points
// DATABASE_URL at a separate `racing_test` database so a test run can never touch dev data.
// Create it once with:
//   docker compose exec db psql -U racing -c "CREATE DATABASE racing_test"
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { hashToken } from './workers';
import { createAdmin, type AdminRole } from './admin/admins';
import { MANAGER_ONLY_CATEGORIES } from './catalog';

export async function applySchema(pool: pg.Pool): Promise<void> {
  await pool.query(readFileSync('db/schema.sql', 'utf8'));
}

/**
 * Clears every table the app writes to, between tests. TRUNCATE ... CASCADE also clears
 * dependents not listed explicitly (submission_lines, charge_batches).
 */
export async function resetSchema(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE submissions, assignments, workers, staff, admins, events, event_customers,
              charge_batch_lines, admin_actions, customers, items RESTART IDENTITY CASCADE`
  );
}

/**
 * A named admin to attribute test writes to. Every admin-side function now requires an actor,
 * so this is as much a fixture as the event and the customer.
 *
 * Uses the real `createAdmin` so the tests exercise the same validation and hashing the app
 * does; the returned temp password is handed back for the login tests.
 */
export async function seedAdmin(
  pool: pg.Pool,
  overrides: { username?: string; name?: string; role?: AdminRole } = {}
): Promise<{ id: number; username: string; name: string; role: AdminRole; password: string }> {
  const username = overrides.username ?? 'testowner';
  const result = await createAdmin(
    {
      username,
      name: overrides.name ?? 'Test Owner',
      role: overrides.role ?? 'owner',
    },
    null
  );
  if (!result.ok) throw new Error(`seedAdmin failed: ${result.reason}`);
  return {
    id: result.id,
    username: result.username,
    name: result.name,
    role: overrides.role ?? 'owner',
    password: result.tempPassword,
  };
}

export interface Fixtures {
  eventId: number;
  workerAId: number;
  workerBId: number;
  staffAId: number;
  staffBId: number;
  customerId: string;
  itemId: string;
  inactiveItemId: string;
  /**
   * An active, sellable item filed under a manager-only QuickBooks category — a service.
   * Workers must not be able to see or record it; managers must be able to add it (§17).
   */
  serviceItemId: string;
  /**
   * Intuit's undeletable stock `Services` item, reproduced faithfully: active, sellable,
   * **no SKU and no category**. The row that leaked onto workers' phones, and the reason
   * `workerVisibleItemSql` requires a SKU rather than trusting the category alone.
   */
  uncategorizedServiceItemId: string;
}

/**
 * One event with one participating customer, two workers (each with a staff identity) both
 * assigned to that customer, one active part, one inactive part, one manager-only service,
 * and one SKU-less uncategorized stock service.
 */
export async function seedFixtures(pool: pg.Pool): Promise<Fixtures> {
  const {
    rows: [event],
  } = await pool.query<{ id: number }>(`INSERT INTO events (code, name) VALUES ('T1', 'Test Event') RETURNING id`);

  const customerId = 'cust-1';
  await pool.query(
    `INSERT INTO customers (qbo_id, display_name, active, sync_token, raw, synced_at)
     VALUES ($1, 'Test Customer', true, '0', '{}'::jsonb, now())`,
    [customerId]
  );

  const itemId = 'item-1';
  const inactiveItemId = 'item-2';
  await pool.query(
    `INSERT INTO items (qbo_id, sku, name, unit_price, type, active, sync_token, raw, synced_at)
     VALUES ($1, 'SKU1', 'Test Part', 9.5, 'NonInventory', true, '0', '{}'::jsonb, now())`,
    [itemId]
  );
  await pool.query(
    `INSERT INTO items (qbo_id, sku, name, unit_price, type, active, sync_token, raw, synced_at)
     VALUES ($1, 'SKU2', 'Inactive Part', 5, 'NonInventory', false, '0', '{}'::jsonb, now())`,
    [inactiveItemId]
  );

  // Priced per race day, like the real thing. 100 makes every service assertion's arithmetic
  // readable at a glance (3 days = 300).
  const serviceItemId = 'item-svc';
  await pool.query(
    `INSERT INTO items (qbo_id, sku, name, unit_price, type, category, active, sync_token, raw, synced_at)
     VALUES ($1, 'SVC-TEST-DAY', 'Test Service (per day) - Servicio de prueba (por día)', 100,
             'Service', $2, true, '0', '{}'::jsonb, now())`,
    [serviceItemId, MANAGER_ONLY_CATEGORIES[0]]
  );

  const uncategorizedServiceItemId = 'item-stock-svc';
  await pool.query(
    `INSERT INTO items (qbo_id, sku, name, unit_price, type, category, active, sync_token, raw, synced_at)
     VALUES ($1, NULL, 'Services', NULL, 'Service', NULL, true, '0', '{}'::jsonb, now())`,
    [uncategorizedServiceItemId]
  );

  // The customer participates in the event (design doc §21) — this row must exist before
  // any assignment or usage, and is the lock row usage/approve serialise on.
  await pool.query(`INSERT INTO event_customers (event_id, customer_qbo_id) VALUES ($1, $2)`, [
    event.id,
    customerId,
  ]);

  const { rows: staff } = await pool.query<{ id: number }>(
    `INSERT INTO staff (name) VALUES ('Worker A'), ('Worker B') RETURNING id`
  );
  const [staffA, staffB] = staff;

  const {
    rows: [workerA],
  } = await pool.query<{ id: number }>(
    `INSERT INTO workers (event_id, staff_id, name, token_hash) VALUES ($1, $2, 'Worker A', $3) RETURNING id`,
    [event.id, staffA.id, hashToken('token-a')]
  );
  const {
    rows: [workerB],
  } = await pool.query<{ id: number }>(
    `INSERT INTO workers (event_id, staff_id, name, token_hash) VALUES ($1, $2, 'Worker B', $3) RETURNING id`,
    [event.id, staffB.id, hashToken('token-b')]
  );
  await pool.query(`INSERT INTO assignments (worker_id, customer_qbo_id) VALUES ($1, $3), ($2, $3)`, [
    workerA.id,
    workerB.id,
    customerId,
  ]);

  return {
    eventId: event.id,
    workerAId: workerA.id,
    workerBId: workerB.id,
    staffAId: staffA.id,
    staffBId: staffB.id,
    customerId,
    itemId,
    inactiveItemId,
    serviceItemId,
    uncategorizedServiceItemId,
  };
}
