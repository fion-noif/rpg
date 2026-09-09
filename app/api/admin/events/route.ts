// Create an event (plan §7). Plain form POST from the dashboard, so it works with
// JavaScript disabled and matches the login page's style; there is nothing secret in the
// response, so a 303 back to the new event's page is the right answer.
//
// M3: `?secret=` is no longer accepted here. It used to be, for script convenience, but
// creating an event is a mutation and every mutation now needs a named actor — the two
// remaining bearer-token endpoints are export and sync, which change nothing.
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminIdentity } from '@/src/admin-session';
import { createEvent } from '@/src/admin/events';
import { redirectBaseUrl } from '@/src/base-url';

export async function POST(req: NextRequest) {
  const auth = await requireAdminIdentity(req);
  if (!auth.ok) return auth.response;

  const form = await req.formData();
  const name = form.get('name');
  const startDate = form.get('startDate');
  const endDate = form.get('endDate');

  // No `code` field any more (M4): the manager supplies the dates and a description, and the
  // event code — which exists to be a QuickBooks DocNumber, not a label — is derived from the
  // start date in createEvent.
  const result = await createEvent({
    name: typeof name === 'string' ? name : '',
    startDate: typeof startDate === 'string' ? startDate : '',
    endDate: typeof endDate === 'string' ? endDate : '',
  });

  // 303 turns the POST into a GET, so a refresh doesn't try to create the event again.
  const to = result.ok ? `/admin/events/${result.eventId}` : `/admin?error=${result.reason}`;
  return NextResponse.redirect(new URL(to, redirectBaseUrl(req)), 303);
}
