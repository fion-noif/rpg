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

export async function POST(req: NextRequest) {
  const auth = await requireAdminIdentity(req);
  if (!auth.ok) return auth.response;

  const form = await req.formData();
  const code = form.get('code');
  const name = form.get('name');

  const result = await createEvent({
    code: typeof code === 'string' ? code : '',
    name: typeof name === 'string' ? name : '',
  });

  // 303 turns the POST into a GET, so a refresh doesn't try to create the event again.
  const to = result.ok ? `/admin/events/${result.eventId}` : `/admin?error=${result.reason}`;
  return NextResponse.redirect(new URL(to, req.nextUrl.origin), 303);
}
