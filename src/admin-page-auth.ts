// Server-Component side of admin auth. Kept out of src/admin-auth.ts so that file stays
// pure and unit-testable under `node --test` (importing next/headers there would drag the
// Next request context into every test).
//
// Pages deliberately do NOT accept `?secret=`: a secret in a page URL leaks into browser
// history, bookmarks, and Referer headers. The two script endpoints under /api/admin still
// take one (src/admin-session.ts).
//
// Every guard here returns the AdminSession, so a page or Server Action that needs to
// attribute a write cannot get at the surface without also getting the actor.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_COOKIE } from './admin-auth';
import { checkAdmin, type AdminCheck, type AdminSession } from './admin-session';

/** Cookie-only check for a Server Component. */
export async function checkAdminPage(): Promise<AdminCheck> {
  const cookie = (await cookies()).get(ADMIN_COOKIE)?.value;
  return checkAdmin({ cookie, allowQuerySecret: false });
}

/**
 * Guard for every `/admin/*` page and Server Action: redirects to the login form unless a
 * valid cookie resolves to an active account. Returns the session, which is what makes
 * per-admin attribution the default rather than something a caller has to remember.
 */
export async function requireAdminPage(): Promise<AdminSession> {
  const check = await checkAdminPage();
  if (!check.ok || check.via !== 'cookie') redirect('/admin/login');
  return check.admin;
}

/**
 * Owner-only surfaces (account management). A signed-in manager is redirected to the
 * dashboard rather than the login page: they are authenticated, just not authorised, and
 * bouncing them to a sign-in form they already satisfied would be a lie.
 */
export async function requireAdminOwnerPage(): Promise<AdminSession> {
  const admin = await requireAdminPage();
  if (admin.role !== 'owner') redirect('/admin?error=owner-only');
  return admin;
}
