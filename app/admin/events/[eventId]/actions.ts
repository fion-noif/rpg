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
  addWorkerAndAssign,
  addWorkerToEvent,
  assign,
  closeEvent,
  listWorkers,
  removeCustomer,
  removeWorkerFromEvent,
  rotateWorkerToken,
  unassign,
  updateEventDates,
} from '@/src/admin/events';
import type { AssignState, LinkState } from './types';

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
 * Which tab the form was submitted from, whitelisted rather than passed through: unlike an
 * `error` reason (which this file produces), the tab arrives from the browser. `undefined`
 * for the default tab, so the common case still redirects to a bare URL.
 */
function tabOf(form: FormData): 'workers' | undefined {
  return form.get('tab') === 'workers' ? 'workers' : undefined;
}

/**
 * Every non-link action ends here: back to a clean URL on success, or to the same page with
 * a machine-readable `?error=` the page turns into a sentence. Reasons are enum-ish strings,
 * never user input, so they are safe in a URL (unlike a token).
 *
 * The tab has to survive the round trip. Now that Workers is a separate panel rather than a
 * section further down the same page, a redirect that dropped it would answer "unassign this
 * customer" by throwing the manager back to the Customers tab.
 */
function finish(eventId: number, reason?: string, tab?: 'workers'): never {
  revalidatePath(`/admin/events/${eventId}`);
  const qs = new URLSearchParams();
  if (tab) qs.set('tab', tab);
  if (reason) qs.set('error', reason);
  const query = qs.toString();
  redirect(`/admin/events/${eventId}${query ? `?${query}` : ''}`);
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
  const admin = await requireAdminAction();
  const result = await assign(num(form, 'workerId'), str(form, 'customerQboId'), admin);
  finish(num(form, 'eventId'), result.ok ? undefined : result.reason, tabOf(form));
}

export async function unassignAction(form: FormData): Promise<never> {
  const admin = await requireAdminAction();
  const result = await unassign(num(form, 'workerId'), str(form, 'customerQboId'), admin);
  finish(num(form, 'eventId'), result.ok ? undefined : result.reason, tabOf(form));
}

export async function removeWorkerAction(form: FormData): Promise<never> {
  const admin = await requireAdminAction();
  const result = await removeWorkerFromEvent(num(form, 'workerId'), admin);
  finish(num(form, 'eventId'), result.ok ? undefined : result.reason, tabOf(form));
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
  // The dates form lives in the header, which persists across tabs, so it has to return you
  // to whichever one you were looking at.
  finish(eventId, result.ok ? undefined : result.reason, tabOf(form));
}

/**
 * Deliberately does not use `finish()`: closing is submitted from its own confirmation page,
 * and a refusal has to come back *there* — to the page showing what blocked it — not to the
 * event page that closing was moved off of.
 */
export async function closeEventAction(form: FormData): Promise<never> {
  const admin = await requireAdminAction();
  const eventId = num(form, 'eventId');
  // `force` is the manager explicitly overriding the all-customers-POSTED guard; the
  // override itself is recorded in admin_actions by closeEvent, under their name.
  const result = await closeEvent(eventId, admin, { force: str(form, 'force') === '1' });

  revalidatePath(`/admin/events/${eventId}`);
  revalidatePath(`/admin/events/${eventId}/close`);
  // The dashboard's per-event status and invoicing counts go stale on a close too — a
  // pre-existing gap, fixed here because this is now the only path that closes an event.
  revalidatePath('/admin');

  // Success lands on the event page, which renders its own read-only closed state.
  if (result.ok) redirect(`/admin/events/${eventId}`);
  // Nothing left to confirm against.
  if (result.reason === 'unknown-event') redirect('/admin');
  redirect(`/admin/events/${eventId}/close?error=${result.reason}`);
}

// ---------------------------------------------------------------------------
// The three actions that mint a credential. These return the link instead of
// redirecting, so it is rendered by the caller and never enters a URL.
// ---------------------------------------------------------------------------

/**
 * The customers-tab workflow: point somebody at this customer, adding them to the event
 * first if they are not on it yet.
 *
 * Returns state rather than redirecting for the usual reason — the third case below can mint
 * a magic link, and a token must never enter a URL. That also means the panel keeps its
 * result on screen instead of being replaced by a page load, which is what makes a
 * one-time link readable at all.
 *
 * One `<select name="who">` carries both kinds of person, namespaced: `w:` for someone
 * already on the event (a plain assignment, no credential) and `s:` for someone who has
 * worked before (add + assign, which mints one).
 */
export async function assignWorkerAction(_prev: AssignState, form: FormData): Promise<AssignState> {
  const check = await checkAdminPage();
  if (!check.ok || check.via !== 'cookie') return { error: 'not-signed-in' };

  const eventId = num(form, 'eventId');
  const customerQboId = str(form, 'customerQboId');
  // Display-only, echoed straight back into the confirmation sentence so the panel does not
  // have to re-look-up a name it already rendered.
  const customerName = str(form, 'customerName');
  const who = str(form, 'who');
  const newName = str(form, 'newName').trim();

  const done = (result: { name: string; link: string | null }): AssignState => ({
    assignedTo: customerName,
    name: result.name,
    link: result.link ?? undefined,
  });

  // Same precedence as addWorkerAction: a typed name beats the picker, because filling it in
  // is the more deliberate act.
  if (newName) {
    const result = await addWorkerAndAssign(
      { eventId, newStaff: { name: newName, language: str(form, 'language') === 'es' ? 'es' : 'en' } },
      customerQboId,
      check.admin
    );
    revalidatePath(`/admin/events/${eventId}`);
    return result.ok ? done(result) : { error: result.reason };
  }

  if (who.startsWith('s:')) {
    const result = await addWorkerAndAssign(
      { eventId, staffId: Number(who.slice(2)) },
      customerQboId,
      check.admin
    );
    revalidatePath(`/admin/events/${eventId}`);
    return result.ok ? done(result) : { error: result.reason };
  }

  if (who.startsWith('w:')) {
    const workerId = Number(who.slice(2));
    const result = await assign(workerId, customerQboId, check.admin);
    revalidatePath(`/admin/events/${eventId}`);
    if (!result.ok) return { error: result.reason };
    // The name is read back rather than carried in a hidden field: a plain <select> cannot
    // submit the label of the chosen option, and the alternative — packing the name into the
    // option value — would put a display string where an id belongs.
    const worker = (await listWorkers(eventId)).find((w) => w.id === workerId);
    // Already on the event, so there is no new credential — the panel says their existing
    // link still works rather than showing a link box.
    return { assignedTo: customerName, name: worker?.name ?? 'That worker', link: undefined };
  }

  return { error: 'invalid-name' };
}

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
