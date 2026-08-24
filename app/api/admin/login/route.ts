// Admin login (plan §2/§7). POST is the browser form; GET is the bookmark upgrade
// path for anyone who still has an old `/admin/usage?secret=…` URL saved.
//
// Both paths funnel through the same throttle + constant-time compare, and neither
// ever echoes the attempted password back to the client.
import { NextRequest, NextResponse } from 'next/server';
import {
  ADMIN_COOKIE,
  adminCookieOptions,
  checkAdmin,
  failureDelay,
  mintAdminCookie,
  recordAttempt,
  throttleKey,
} from '@/src/admin-auth';
import { config } from '@/src/config';

function redirect(req: NextRequest, path: string): NextResponse {
  // 303: turns the form POST into a GET of the destination, so a refresh of
  // /admin doesn't re-submit the password.
  return NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
}

async function login(req: NextRequest, provided: string | null): Promise<NextResponse> {
  if (!config.adminSecret) return redirect(req, '/admin/login?unconfigured=1');

  if (!recordAttempt(throttleKey(req.headers))) {
    await failureDelay();
    return redirect(req, '/admin/login?throttled=1');
  }

  // checkAdmin owns the comparison so there is exactly one place that decides.
  const check = checkAdmin({ secret: provided, allowQuerySecret: true });
  if (!check.ok) {
    await failureDelay();
    return redirect(req, '/admin/login?error=1');
  }

  const res = redirect(req, '/admin');
  res.cookies.set(ADMIN_COOKIE, mintAdminCookie(config.adminSecret), adminCookieOptions());
  return res;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Form-encoded, not JSON: the login form must work with JavaScript disabled.
  const form = await req.formData();
  const password = form.get('password');
  return login(req, typeof password === 'string' ? password : null);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return login(req, req.nextUrl.searchParams.get('secret'));
}
