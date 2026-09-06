'use server';

// Account management mutations (M3). Server Actions, in the same style and for the same
// reason as app/admin/events/[eventId]/actions.ts: creating or resetting an account mints a
// one-time password that must be shown exactly once and must never appear in a URL, where it
// would land in browser history, the Referer header, and any screen share of the address bar.
// A Server Action can return it as a value for the client component to render in place.
//
// Every action re-checks the cookie *and* the owner role. A Server Action is a POST endpoint
// reachable by anyone who learns its id, so "the page already checked" is not a check — and
// role is checked here rather than in src/admin/admins.ts because that module is also the
// bootstrap CLI's entry point, which has no session at all.
// (src/admin-auth.test.ts walks this file for the guard reference.)
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { checkAdminPage, requireAdminOwnerPage } from '@/src/admin-page-auth';
import { ADMIN_COOKIE, adminCookieOptions, mintAdminCookie } from '@/src/admin-auth';
import { config } from '@/src/config';
import {
  changeOwnPassword,
  createAdmin,
  resetAdminPassword,
  setAdminActive,
} from '@/src/admin/admins';
import type { AccountState, TempPasswordState } from './types';

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

function num(form: FormData, key: string): number {
  return Number(form.get(key));
}

/**
 * Owner-only guard that returns state instead of redirecting: these actions render their
 * result into the page they were submitted from, so a bounce would throw away the outcome.
 */
async function requireOwnerAction(): Promise<
  { ok: true; admin: { id: number; name: string } } | { ok: false; state: { error: string } }
> {
  const check = await checkAdminPage();
  if (!check.ok || check.via !== 'cookie') return { ok: false, state: { error: 'not-signed-in' } };
  if (check.admin.role !== 'owner') return { ok: false, state: { error: 'owner-only' } };
  return { ok: true, admin: check.admin };
}

export async function createAdminAction(
  _prev: TempPasswordState,
  form: FormData
): Promise<TempPasswordState> {
  const auth = await requireOwnerAction();
  if (!auth.ok) return auth.state;

  const result = await createAdmin(
    {
      username: str(form, 'username'),
      name: str(form, 'name'),
      // Only managers can be created from the UI. A second owner is a deliberate act with
      // real consequences (they can deactivate other owners), so it goes through the CLI
      // where it is visible in shell history and requires server access.
      role: 'manager',
    },
    auth.admin
  );
  revalidatePath('/admin/admins');
  if (!result.ok) return { error: result.reason };
  return { name: result.name, username: result.username, password: result.tempPassword };
}

export async function resetPasswordAction(
  _prev: TempPasswordState,
  form: FormData
): Promise<TempPasswordState> {
  const auth = await requireOwnerAction();
  if (!auth.ok) return auth.state;

  const result = await resetAdminPassword(num(form, 'adminId'), auth.admin);
  revalidatePath('/admin/admins');
  if (!result.ok) return { error: result.reason };
  return { name: result.name, username: result.username, password: result.tempPassword };
}

export async function setActiveAction(form: FormData): Promise<void> {
  const admin = await requireAdminOwnerPage();
  const result = await setAdminActive(num(form, 'adminId'), str(form, 'active') === '1', admin);
  revalidatePath('/admin/admins');
  // Reasons are enum-ish strings, never user input, so they are safe in a URL — unlike the
  // temp password the other two actions return.
  if (!result.ok) redirect(`/admin/admins?error=${result.reason}`);
  redirect('/admin/admins');
}

/**
 * Self-service password change, available to any signed-in admin (not owner-only).
 *
 * Re-mints this session's cookie from the new `token_version`: the bump signs out every
 * *other* session for this account, which is the point of changing a password you suspect is
 * known, but signing out the person doing it would be a bug dressed up as security.
 */
export async function changePasswordAction(
  _prev: AccountState,
  form: FormData
): Promise<AccountState> {
  const check = await checkAdminPage();
  if (!check.ok || check.via !== 'cookie') return { error: 'not-signed-in' };

  const result = await changeOwnPassword(
    check.admin.id,
    str(form, 'currentPassword'),
    str(form, 'newPassword')
  );
  if (!result.ok) return { error: result.reason };

  if (config.adminSecret) {
    (await cookies()).set(
      ADMIN_COOKIE,
      mintAdminCookie(config.adminSecret, {
        adminId: check.admin.id,
        tokenVersion: result.tokenVersion,
      }),
      adminCookieOptions()
    );
  }
  return { changed: true };
}
