// Server-Component side of admin auth. Kept out of src/admin-auth.ts so that file
// stays pure and unit-testable under `node --test` (importing next/headers there
// would drag the Next request context into every test).
//
// Pages deliberately do NOT accept `?secret=`: a secret in a page URL leaks into
// browser history, bookmarks, and Referer headers. Scripts use /api/admin/* instead.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_COOKIE, checkAdmin, type AdminCheck } from './admin-auth';

/** Cookie-only check for a Server Component. */
export async function checkAdminPage(): Promise<AdminCheck> {
  const cookie = (await cookies()).get(ADMIN_COOKIE)?.value;
  return checkAdmin({ cookie, allowQuerySecret: false });
}

/**
 * Guard for every `/admin/*` page: redirects to the login form unless a valid
 * cookie is present. Returns nothing on success so callers just `await` it.
 */
export async function requireAdminPage(): Promise<void> {
  const check = await checkAdminPage();
  if (!check.ok) redirect('/admin/login');
}
