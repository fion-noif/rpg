// Shared setup for integration tests that run against a real Postgres instance. Tests import
// `pool` from ./db exactly like the app does; the "test" script in package.json points
// DATABASE_URL at a separate `racing_test` database so a test run can never touch dev data.
// Create it once with:
//   docker compose exec db psql -U racing -c "CREATE DATABASE racing_test"
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { hashToken } from './workers';

export async function applySchema(pool: pg.Pool): Promise<void> {
  await pool.query(readFileSync('db/schema.sql', 'utf8'));
}

/**
 * Clears every table the app writes to, between tests. TRUNCATE ... CASCADE also clears
 * dependents not listed explicitly (submission_lines, charge_batches).
 */
export async function resetSchema(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE submissions, assignments, workers, events, customers, items RESTART IDENTITY CASCADE`
  );
}

export interface Fixtures {
  eventId: number;
  workerAId: number;
  workerBId: number;
  customerId: string;
  itemId: string;
  inactiveItemId: string;
}

/** One event, two workers both assigned to one customer, one active item, one inactive item. */
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

  const {
    rows: [workerA],
  } = await pool.query<{ id: number }>(
    `INSERT INTO workers (event_id, name, token_hash) VALUES ($1, 'Worker A', $2) RETURNING id`,
    [event.id, hashToken('token-a')]
  );
  const {
    rows: [workerB],
  } = await pool.query<{ id: number }>(
    `INSERT INTO workers (event_id, name, token_hash) VALUES ($1, 'Worker B', $2) RETURNING id`,
    [event.id, hashToken('token-b')]
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
    customerId,
    itemId,
    inactiveItemId,
  };
}
