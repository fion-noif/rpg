// Named admin accounts (M3). Mike Rolison owns the team and hires managers; each of them
// signs in as themselves so every audit row names a person (§23 Rule 4).
//
// Two roles, no permission table: `owner` can manage accounts, `manager` can run a weekend.
// A third role is a schema change, deliberately — role proliferation is the kind of platform
// debt that is cheap to add and expensive to remove, and there is no caller for one yet.
//
// Every mutation here also appends to `admin_actions` with the acting admin's id: creating,
// deactivating or resetting someone else's credential is exactly the sort of thing that
// needs a name against it.
import pg from 'pg';
import { pool } from '../db';
import { generateTempPassword, hashPassword, verifyPassword } from '../admin-password';

export type AdminRole = 'owner' | 'manager';

/**
 * The minimum an audit row needs: who, and under what name. Business logic takes this
 * rather than the full session so src/ modules don't depend on the auth layer (the
 * dependency runs the other way: src/admin-session.ts builds an AdminSession from a row here).
 */
export interface AdminActor {
  id: number;
  name: string;
}

export interface AdminRecord {
  id: number;
  username: string;
  name: string;
  role: AdminRole;
  active: boolean;
  createdAt: string;
}

/** Same shape as AdminRecord plus what the auth layer needs to validate a cookie. */
export interface AdminCredentials extends AdminRecord {
  tokenVersion: number;
}

const COLUMNS = `id, username, name, role, active, token_version AS "tokenVersion",
                 created_at AS "createdAt"`;

// Deliberately narrow: usernames end up in URLs, CLI arguments and log lines, so the set of
// characters that can appear is the set that is boring everywhere.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/** Real names are free-form; only whitespace shape is normalised. */
function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeUsername(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

async function logAction(
  client: pg.PoolClient,
  action: string,
  adminId: number | null,
  detail: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO admin_actions (action, admin_id, detail) VALUES ($1, $2, $3::jsonb)`,
    [action, adminId, JSON.stringify(detail)]
  );
}

async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Owner's account list. Includes deactivated accounts — they are history, not noise. */
export async function listAdmins(): Promise<AdminRecord[]> {
  // Owners first, then alphabetical. Not `ORDER BY role`, which would sort 'manager' above
  // 'owner' — alphabetical order of an enum's spelling is never the order you meant.
  const res = await pool.query<AdminCredentials>(
    `SELECT ${COLUMNS} FROM admins
     ORDER BY active DESC, (role = 'owner') DESC, username`
  );
  return res.rows;
}

export async function getAdmin(id: number): Promise<AdminCredentials | undefined> {
  const res = await pool.query<AdminCredentials>(`SELECT ${COLUMNS} FROM admins WHERE id = $1`, [id]);
  return res.rows[0];
}

/** True when at least one active owner exists — the bootstrap script's "is this a fresh DB". */
export async function hasAnyAdmin(): Promise<boolean> {
  const res = await pool.query('SELECT 1 FROM admins LIMIT 1');
  return res.rowCount! > 0;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export type AuthResult =
  | { ok: true; admin: AdminCredentials }
  | { ok: false; reason: 'unknown-username' | 'inactive' | 'wrong-password' };

/**
 * Verifies a username/password pair. The distinct reasons are for the server log and the
 * tests — the login route collapses all three into one "sign-in failed" message, because
 * telling an attacker which half was wrong hands them a username oracle.
 *
 * The hash is fetched and verified even for an inactive account, so a deactivated manager's
 * login takes the same ~50ms as anyone else's rather than returning early and advertising
 * "this username exists but is switched off".
 */
export async function authenticateAdmin(username: string, password: string): Promise<AuthResult> {
  const handle = normalizeUsername(username);
  const res = await pool.query<AdminCredentials & { password_hash: string }>(
    `SELECT ${COLUMNS}, password_hash FROM admins WHERE username = $1`,
    [handle]
  );
  const row = res.rows[0];
  if (!row) {
    // Burn a comparable amount of time on an unknown username so the response time does not
    // distinguish "no such account" from "wrong password".
    verifyPassword(password, hashPassword('decoy'));
    return { ok: false, reason: 'unknown-username' };
  }
  const matches = verifyPassword(password, row.password_hash);
  if (!matches) return { ok: false, reason: 'wrong-password' };
  if (!row.active) return { ok: false, reason: 'inactive' };
  const { password_hash: _ignored, ...admin } = row;
  return { ok: true, admin };
}

// ---------------------------------------------------------------------------
// Account management (owner-only at the surface; enforced by the caller)
// ---------------------------------------------------------------------------

export type CreateAdminResult =
  | { ok: true; id: number; username: string; name: string; tempPassword: string }
  | { ok: false; reason: 'invalid-username' | 'invalid-name' | 'duplicate-username' };

/**
 * Creates an account with a generated one-time password, returned exactly once — same
 * discipline as a worker magic link (src/admin/events.ts loginLink): shown in the response
 * body, never put in a URL, never stored in plaintext. Losing it means a reset, not a lookup.
 *
 * `by` is null only for the bootstrap CLI, which runs before any admin exists.
 */
export async function createAdmin(
  input: { username: string; name: string; role: AdminRole },
  by: AdminActor | null
): Promise<CreateAdminResult> {
  const username = normalizeUsername(input.username);
  if (!USERNAME_RE.test(username)) return { ok: false, reason: 'invalid-username' };
  const name = normalizeName(input.name);
  if (!name) return { ok: false, reason: 'invalid-name' };

  const tempPassword = generateTempPassword();

  return withTx(async (client) => {
    // The UNIQUE index is the arbiter of a duplicate, not a prior SELECT — a check-then-insert
    // would lose a concurrent create and surface as a raw Postgres error.
    const res = await client.query<{ id: number }>(
      `INSERT INTO admins (username, name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [username, name, hashPassword(tempPassword), input.role]
    );
    if (res.rows.length === 0) return { ok: false as const, reason: 'duplicate-username' as const };

    const id = res.rows[0].id;
    await logAction(client, 'create-admin', by?.id ?? null, {
      adminId: id,
      username,
      name,
      role: input.role,
      by: by?.name ?? 'cli',
    });
    return { ok: true as const, id, username, name, tempPassword };
  });
}

export type SetActiveResult =
  | { ok: true; active: boolean }
  | { ok: false; reason: 'unknown-admin' | 'self' | 'last-owner' };

/**
 * Deactivation is the revocation path for a person, and it is immediate: bumping
 * `token_version` in the same statement kills their outstanding cookies (src/admin-session.ts
 * re-checks both flags on every request), so a manager who leaves mid-weekend is out of the
 * app on their very next click rather than at cookie expiry.
 *
 * The row is never deleted: `admin_actions.admin_id` points at it, and §31 forbids destroying
 * history to tidy up a list.
 *
 * Two guards: you cannot deactivate yourself (locking yourself out of the only page that can
 * undo it), and you cannot deactivate the last active owner (same lockout, one step removed).
 */
export async function setAdminActive(
  id: number,
  active: boolean,
  by: AdminActor
): Promise<SetActiveResult> {
  if (id === by.id && !active) return { ok: false, reason: 'self' };

  return withTx(async (client) => {
    const target = (
      await client.query<{ role: AdminRole; active: boolean; username: string }>(
        'SELECT role, active, username FROM admins WHERE id = $1 FOR UPDATE',
        [id]
      )
    ).rows[0];
    if (!target) return { ok: false as const, reason: 'unknown-admin' as const };

    if (!active && target.role === 'owner' && target.active) {
      const others = await client.query(
        `SELECT 1 FROM admins WHERE role = 'owner' AND active AND id <> $1 LIMIT 1`,
        [id]
      );
      if (others.rowCount === 0) return { ok: false as const, reason: 'last-owner' as const };
    }

    // token_version moves on reactivation too: a cookie minted before the deactivation must
    // not come back to life just because the account did.
    await client.query(
      'UPDATE admins SET active = $2, token_version = token_version + 1 WHERE id = $1',
      [id, active]
    );
    await logAction(client, active ? 'reactivate-admin' : 'deactivate-admin', by.id, {
      adminId: id,
      username: target.username,
      by: by.name,
    });
    return { ok: true as const, active };
  });
}

export type ResetPasswordResult =
  | { ok: true; username: string; name: string; tempPassword: string }
  | { ok: false; reason: 'unknown-admin' };

/**
 * Owner resets a manager's password: new one-time password, shown once, and
 * `token_version` bumped so whoever was holding the old session is signed out. This is the
 * "a manager lost their password" path *and* the "a manager's laptop walked" path.
 */
export async function resetAdminPassword(id: number, by: AdminActor): Promise<ResetPasswordResult> {
  const tempPassword = generateTempPassword();
  return withTx(async (client) => {
    const res = await client.query<{ username: string; name: string }>(
      `UPDATE admins SET password_hash = $2, token_version = token_version + 1
       WHERE id = $1 RETURNING username, name`,
      [id, hashPassword(tempPassword)]
    );
    if (res.rows.length === 0) return { ok: false as const, reason: 'unknown-admin' as const };
    await logAction(client, 'reset-admin-password', by.id, {
      adminId: id,
      username: res.rows[0].username,
      by: by.name,
    });
    return { ok: true as const, ...res.rows[0], tempPassword };
  });
}

export type ChangePasswordResult =
  | { ok: true; tokenVersion: number }
  | { ok: false; reason: 'unknown-admin' | 'wrong-current' | 'weak-password' };

/** Anything shorter is not a password, it is a formality. Temp passwords are 12. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Self-service change, which is how a temp password stops being a temp password.
 *
 * Requires the current password (a stolen cookie must not be enough to take the account
 * over) and bumps `token_version`, which signs out every *other* session for this admin —
 * the point of changing a password you suspect is known. The caller re-mints its own cookie
 * from the returned version so the person doing the change stays signed in.
 */
export async function changeOwnPassword(
  id: number,
  currentPassword: string,
  newPassword: string
): Promise<ChangePasswordResult> {
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'weak-password' };
  }
  return withTx(async (client) => {
    const row = (
      await client.query<{ password_hash: string; username: string }>(
        'SELECT password_hash, username FROM admins WHERE id = $1 FOR UPDATE',
        [id]
      )
    ).rows[0];
    if (!row) return { ok: false as const, reason: 'unknown-admin' as const };
    if (!verifyPassword(currentPassword, row.password_hash)) {
      return { ok: false as const, reason: 'wrong-current' as const };
    }

    const updated = await client.query<{ token_version: number }>(
      `UPDATE admins SET password_hash = $2, token_version = token_version + 1
       WHERE id = $1 RETURNING token_version`,
      [id, hashPassword(newPassword)]
    );
    await logAction(client, 'change-password', id, { adminId: id, username: row.username });
    return { ok: true as const, tokenVersion: updated.rows[0].token_version };
  });
}
