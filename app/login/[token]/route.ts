// Magic-link login (design doc §14): validates the worker token and sets the session cookie.
import { NextRequest, NextResponse } from 'next/server';
import { resolveToken, SESSION_COOKIE } from '@/src/workers';
import { config } from '@/src/config';

/** A week, as before — but now only ever a ceiling; see the `maxAge` note below. */
const MAX_SESSION_SECONDS = 60 * 60 * 24 * 7;

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const resolution = await resolveToken(token);
  // In dev, `next dev` (without -H) ignores the incoming Host header when resolving
  // req.url, so it always resolves against localhost — read Host directly to support
  // testing from other devices on the LAN. In production the Host header can be
  // spoofed by the client, so redirect against the configured app URL instead.
  const base =
    process.env.NODE_ENV === 'production'
      ? config.appBaseUrl
      : `${req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '')}://${req.headers.get('host') ?? req.nextUrl.host}`;
  // A failed login carries its reason to the landing page: with no cookie set, the page
  // cannot tell "expired" from "never valid" on its own, and those need different words —
  // one means ask for a new link, the other means the link is wrong (M4).
  const target = resolution.ok ? '/' : `/?link=${resolution.reason}`;
  const res = NextResponse.redirect(new URL(target, base));
  if (resolution.ok) {
    // Capped at the credential's own remaining life, not a flat week: a session that
    // outlives the event it belongs to just turns into a 401 the worker cannot explain.
    const untilExpiry = Math.floor((resolution.expiresAt.getTime() - Date.now()) / 1000);
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: Math.min(MAX_SESSION_SECONDS, Math.max(untilExpiry, 0)),
      path: '/',
    });
  }
  return res;
}
