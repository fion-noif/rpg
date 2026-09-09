// Admin logout. Deliberately does NOT call checkAdmin: clearing your own cookie
// needs no authorization, and refusing to log out an already-expired session would
// be a worse experience for no security gain. (It is a POST so a stray <img> or
// link prefetch can't sign the manager out.)
import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_COOKIE, adminCookieOptions } from '@/src/admin-auth';
import { redirectBaseUrl } from '@/src/base-url';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const res = NextResponse.redirect(new URL('/admin/login', redirectBaseUrl(req)), 303);
  // Same attributes as the mint, with maxAge 0 — otherwise the browser may keep
  // the original cookie because the delete doesn't match on path/secure.
  res.cookies.set(ADMIN_COOKIE, '', { ...adminCookieOptions(), maxAge: 0 });
  return res;
}
