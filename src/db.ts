import pg from 'pg';
import { config } from './config';

// Single shared pool; Next.js hot-reload guard via globalThis.
const globalForDb = globalThis as unknown as { pgPool?: pg.Pool };

export const pool =
  globalForDb.pgPool ??
  new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

globalForDb.pgPool = pool;

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export interface TokenRow {
  realm_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
}

export async function loadTokens(): Promise<TokenRow | undefined> {
  const rows = await q<TokenRow>('SELECT * FROM qbo_tokens WHERE id = 1');
  if (!rows[0]) return undefined;
  // BIGINT comes back as string from pg.
  return {
    ...rows[0],
    access_expires_at: Number(rows[0].access_expires_at),
    refresh_expires_at: Number(rows[0].refresh_expires_at),
  };
}

export async function saveTokens(row: TokenRow): Promise<void> {
  await q(
    `INSERT INTO qbo_tokens (id, realm_id, access_token, refresh_token, access_expires_at, refresh_expires_at, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       realm_id = $1, access_token = $2, refresh_token = $3,
       access_expires_at = $4, refresh_expires_at = $5, updated_at = $6`,
    [row.realm_id, row.access_token, row.refresh_token, row.access_expires_at, row.refresh_expires_at, Date.now()]
  );
}
