// Step 2 of admin auth (M3): turn a signed cookie into a *person*.
//
// src/admin-auth.ts proves the cookie was minted by this server and hasn't expired. That is
// not enough to act on: the account may have been deactivated or had its password changed
// since. So every request also reads the row and requires `active AND token_version =
// cookie.tokenVersion`. One indexed primary-key lookup per admin request, in exchange for
// revocation that takes effect on the next click instead of at cookie expiry.
//
// The `?secret=` policy lives here too, and it is a policy, not a convenience:
//
//   - read/script endpoints (`/api/admin/export`, `/api/admin/sync`) accept ADMIN_SECRET,
//     because a cron job has no name and these change nothing;
//   - every mutating surface requires a cookie, because `admin_actions` needs a who
//     (§23 Rule 4). `requireAdminIdentity` is the guard that says so in the type system.
import type { NextRequest } from 'next/server';
import { ADMIN_COOKIE, matchesAdminSecret, verifyAdminCookie } from './admin-auth';
import { config } from './config';
import { pool } from './db';
import type { AdminActor, AdminRole } from './admin/admins';

/** The signed-in admin. `AdminActor`-compatible, so it can be handed straight to src/ logic. */
export interface AdminSession extends AdminActor {
  id: number;
  username: string;
  name: string;
  role: AdminRole;
}

export type AdminCheck =
  | { ok: true; via: 'cookie'; admin: AdminSession }
  /** ADMIN_SECRET presented directly — authenticated, but anonymous. Reads only. */
  | { ok: true; via: 'query' }
  | { ok: false; reason: 'unconfigured' | 'unauthenticated' };

export interface AdminCheckInput {
  cookie?: string | null;
  secret?: string | null;
  allowQuerySecret?: boolean;
  now?: number;
}

/**
 * Resolves cookie claims against the accounts table. Returns null for a deleted, deactivated
 * or version-bumped account — all three are "this cookie is no longer good", and the caller
 * has nothing useful to do differently between them.
 */
export async function sessionForClaims(claims: {
  adminId: number;
  tokenVersion: number;
}): Promise<AdminSession | null> {
  const res = await pool.query<AdminSession & { token_version: number; active: boolean }>(
    `SELECT id, username, name, role, active, token_version FROM admins WHERE id = $1`,
    [claims.adminId]
  );
  const row = res.rows[0];
  if (!row || !row.active) return null;
  if (row.token_version !== claims.tokenVersion) return null;
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}

/** The single decision function. Async now — the identity lives in the database. */
export async function checkAdmin({
  cookie,
  secret,
  allowQuerySecret = false,
  now,
}: AdminCheckInput): Promise<AdminCheck> {
  if (!config.adminSecret) return { ok: false, reason: 'unconfigured' };

  const claims = verifyAdminCookie(cookie, config.adminSecret, now);
  if (claims) {
    const admin = await sessionForClaims(claims);
    if (admin) return { ok: true, via: 'cookie', admin };
  }
  if (allowQuerySecret && matchesAdminSecret(secret)) return { ok: true, via: 'query' };
  return { ok: false, reason: 'unauthenticated' };
}

export function checkAdminRequest(req: NextRequest, allowQuerySecret = false): Promise<AdminCheck> {
  return checkAdmin({
    cookie: req.cookies.get(ADMIN_COOKIE)?.value,
    secret: req.nextUrl.searchParams.get('secret'),
    allowQuerySecret,
  });
}

function deny(reason: 'unconfigured' | 'unauthenticated'): Response {
  const body =
    reason === 'unconfigured'
      ? { error: 'admin not configured: ADMIN_SECRET is not set on the server' }
      : { error: 'forbidden' };
  return new Response(JSON.stringify(body), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Guard for the two script endpoints. Returns a Response to return early, or null to
 * proceed; carries no identity, because `?secret=` has none to carry. Anything that writes
 * should use `requireAdminIdentity` instead.
 */
export async function requireAdmin(req: NextRequest): Promise<Response | null> {
  const check = await checkAdminRequest(req, true);
  return check.ok ? null : deny(check.reason);
}

export type AdminIdentityGuard =
  | { ok: true; admin: AdminSession }
  | { ok: false; response: Response };

/**
 * Guard for every mutating admin route: cookie only, and the session comes back with it so
 * the handler cannot forget to attribute the write. The `?secret=` bearer path is not
 * reachable from here at all — that is the point.
 */
export async function requireAdminIdentity(req: NextRequest): Promise<AdminIdentityGuard> {
  const check = await checkAdminRequest(req, false);
  if (!check.ok) return { ok: false, response: deny(check.reason) };
  // Unreachable in practice (allowQuerySecret is false), but the compiler wants the arm and
  // an anonymous caller must never be handed an identity by default.
  if (check.via !== 'cookie') return { ok: false, response: deny('unauthenticated') };
  return { ok: true, admin: check.admin };
}
