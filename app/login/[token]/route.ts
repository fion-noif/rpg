// Magic-link login (design doc §14): validates the worker token and sets the session cookie.
import { NextRequest, NextResponse } from 'next/server';
import { workerByToken, SESSION_COOKIE } from '@/src/workers';
import { config } from '@/src/config';

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const worker = await workerByToken(token);
  // In dev, `next dev` (without -H) ignores the incoming Host header when resolving
  // req.url, so it always resolves against localhost — read Host directly to support
  // testing from other devices on the LAN. In production the Host header can be
  // spoofed by the client, so redirect against the configured app URL instead.
  const base =
    process.env.NODE_ENV === 'production'
      ? config.appBaseUrl
      : `${req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '')}://${req.headers.get('host') ?? req.nextUrl.host}`;
  const res = NextResponse.redirect(new URL('/', base));
  if (worker) {
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // covers a race weekend with margin
      path: '/',
    });
  }
  return res;
}
