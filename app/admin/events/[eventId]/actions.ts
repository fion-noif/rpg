'use server';

// Mutations for the event detail page (plan §7).
//
// WHY SERVER ACTIONS HERE, when every other mutation in this app is a route handler:
// adding a worker mints a magic-link token that must be shown to the manager exactly once
// and must never appear in a URL — a 303 back with `?linkToken=…` would leak a live
// credential into browser history, the Referer header, and any screen share of the address
// bar. A Server Action can hand the token straight back as a return value, which the small
// client components in this directory render in place. Every mutation on this page is an
// action so the page stays internally consistent; the dashboard's create-event form (which
// has no secret to return) stays a plain form POST to app/api/admin/events/route.ts.
//
// Server Actions are POST endpoints reachable by anyone who learns their id, so every one of
// them re-checks the admin cookie — the same guard the page itself uses. (src/admin-auth.test.ts
// walks this file for that reference.)
//
// M3: the re-check also *returns* the admin, and every mutation below passes it down. That is
// deliberate plumbing rather than a lookup at the bottom of the stack: the business logic in
// src/ takes an actor as a required argument, so an unattributed write does not typecheck.
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { checkAdminPage, requireAdminPage } from '@/src/admin-page-auth';
import type { AdminSession } from '@/src/admin-session';
import {
  addCustomer,
  addWorkerToEvent,
  assign,
  closeEvent,
  removeCustomer,
  removeWorkerFromEvent,
  rotateWorkerToken,
  unassign,
  updateEventDates,
} from '@/src/admin/events';
import type { LinkState } from './types';

async function requireAdminAction(): Promise<AdminSession> {
  return requireAdminPage();
}

function num(form: FormData, key: string): number {
  return Number(form.get(key));
}

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * Every non-link action ends here: back to a clean URL on success, or to the same page with
 * a machine-readable `?error=` the page turns into a sentence. Reasons are enum-ish strings,
 * never user input, so they are safe in a URL (unlike a token).
 */
function finish(eventId: number, reason?: string): never {
  revalidatePath(`/admin/events/${eventId}`);
  redirect(reason ? `/admin/events/${eventId}?error=${reason}` : `/admin/events/${eventId}`);
}

export async function addCustomerAction(form: FormData): Promise<never> {
  const admin = await requireAdminAction();
  const eventId = num(form, 'eventId');
  const result = await addCustomer(eventId, str(form, 'customerQboId'), admin);
  finish(eventId, result.ok ? undefined : result.reason);
}

export async function removeCustomerAction(form: FormData): Promise<never> {
  const admin = await requireAdminAction();
  const eventId = num(form, 'eventId');
  const result = await removeCustomer(eventId, str(form, 'customerQboId'), admin);
  finish(eventId, result.ok ? undefined : result.reason);
}

export async function assignAction(form: FormData): Promise<never> {
  await requireAdminAction();
  const result = await assign(num(form, 'workerId'), str(form, 'customerQboId'));
  finish(num(form, 'eventId'), result.ok ? undefined : result.reason);
}

export async function unassignAction(form: FormData): Promise<never> {
  await requireAdminAction();
  const result = await unassign(num(form, 'workerId'), str(form, 'customerQboId'));
  finish(num(form, 'eventId'), result.ok ? undefined : result.reason);
}

export async function removeWorkerAction(form: FormData): Promise<never> {
  const admin = await requireAdminAction();
  const result = await removeWorkerFromEvent(num(form, 'workerId'), admin);
  finish(num(form, 'eventId'), result.ok ? undefined : result.reason);
}

/**
 * Moving the weekend's dates. Worth knowing while reading this page: this is the *only*
 * remedy for a weekend that ran past its end date, because worker link expiry is derived
 * from that date (src/workers.ts) — rotating a worker's link re-derives the same dead
 * expiry, so extending the event is what restores access.
 */
export async function updateEventDatesAction(form: FormData): Promise<never> {
  const admin = await requireAdminAction();
  const eventId = num(form, 'eventId');
  const result = await updateEventDates(
    eventId,
    { startDate: str(form, 'startDate'), endDate: str(form, 'endDate') },
    admin
  );
  finish(eventId, result.ok ? undefined : result.reason);
}

export async function closeEventAction(form: FormData): Promise<never> {
  const admin = await requireAdminAction();
  const eventId = num(form, 'eventId');
  // `force` is the manager explicitly overriding the all-customers-POSTED guard; the
  // override itself is recorded in admin_actions by closeEvent, under their name.
  const result = await closeEvent(eventId, admin, { force: str(form, 'force') === '1' });
  finish(eventId, result.ok ? undefined : result.reason);
}

// ---------------------------------------------------------------------------
// The two actions that mint a credential. These return the link instead of
// redirecting, so it is rendered by the caller and never enters a URL.
// ---------------------------------------------------------------------------

export async function addWorkerAction(_prev: LinkState, form: FormData): Promise<LinkState> {
  // These two return a value instead of redirecting, so they report "not signed in" as state
  // rather than bouncing — the caller is a form the user is standing in front of.
  const check = await checkAdminPage();
  if (!check.ok || check.via !== 'cookie') return { error: 'not-signed-in' };

  const eventId = num(form, 'eventId');
  const staffId = str(form, 'staffId');
  const newName = str(form, 'newName').trim();

  // The form offers both a picker and a new-name box; a typed name wins, because filling it
  // in is the more deliberate act.
  const result = newName
    ? await addWorkerToEvent(
        {
          eventId,
          newStaff: { name: newName, language: str(form, 'language') === 'es' ? 'es' : 'en' },
        },
        check.admin
      )
    : staffId
      ? await addWorkerToEvent({ eventId, staffId: Number(staffId) }, check.admin)
      : ({ ok: false, reason: 'invalid-name' } as const);

  revalidatePath(`/admin/events/${eventId}`);
  if (!result.ok) return { error: result.reason };
  return result.link
    ? { link: result.link, name: result.name }
    : { name: result.name, existing: true };
}

export async function rotateTokenAction(_prev: LinkState, form: FormData): Promise<LinkState> {
  const check = await checkAdminPage();
  if (!check.ok || check.via !== 'cookie') return { error: 'not-signed-in' };

  const result = await rotateWorkerToken(num(form, 'workerId'), check.admin);
  revalidatePath(`/admin/events/${num(form, 'eventId')}`);
  if (!result.ok) return { error: result.reason };
  return { link: result.link, name: str(form, 'workerName') };
}
