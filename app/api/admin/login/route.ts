// Admin login (plan §2/§7, M3 named accounts). Username + password against `admins`.
//
// What is deliberately absent: the old GET handler that traded an `?secret=` URL for a
// cookie. That minted an identity-less session, and there is no such thing any more — a
// cookie names a person. ADMIN_SECRET's remaining jobs are HMAC key material, the two
// script endpoints, and bootstrap (npm run create-admin).
//
// The response never says *which* half was wrong. `authenticateAdmin` distinguishes
// unknown-username / wrong-password / inactive internally for the tests and the log; all
// three come back to the browser as one message, because "that username exists" is a fact
// worth not confirming.
import { NextRequest, NextResponse } from 'next/server';
import {
  ADMIN_COOKIE,
  adminCookieOptions,
  failureDelay,
  mintAdminCookie,
  recordAttempt,
  throttleKey,
} from '@/src/admin-auth';
import { authenticateAdmin } from '@/src/admin/admins';
import { config } from '@/src/config';

function redirect(req: NextRequest, path: string): NextResponse {
  // 303: turns the form POST into a GET of the destination, so a refresh of
  // /admin doesn't re-submit the password.
  return NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ADMIN_SECRET is still required: it is the key the session cookie is signed with, so
  // without it nobody can hold a session even with a correct password.
  if (!config.adminSecret) return redirect(req, '/admin/login?unconfigured=1');

  if (!recordAttempt(throttleKey(req.headers))) {
    await failureDelay();
    return redirect(req, '/admin/login?throttled=1');
  }

  // Form-encoded, not JSON: the login form must work with JavaScript disabled.
  const form = await req.formData();
  const username = form.get('username');
  const password = form.get('password');

  const result = await authenticateAdmin(
    typeof username === 'string' ? username : '',
    typeof password === 'string' ? password : ''
  );
  if (!result.ok) {
    await failureDelay();
    return redirect(req, '/admin/login?error=1');
  }

  const res = redirect(req, '/admin');
  res.cookies.set(
    ADMIN_COOKIE,
    mintAdminCookie(config.adminSecret, {
      adminId: result.admin.id,
      tokenVersion: result.admin.tokenVersion,
    }),
    adminCookieOptions()
  );
  return res;
}
