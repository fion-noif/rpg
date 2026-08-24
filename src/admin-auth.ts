// Admin (owner/manager) auth — design doc §8, plan §2.
//
// One stateless signed cookie, no session table: `rw_admin = v1.<expiryMs>.<hmacHex>`,
// keyed off ADMIN_SECRET. Rotating ADMIN_SECRET invalidates every outstanding cookie,
// which is intentional — it is the only revocation lever we have.
//
// Everything here is pure (no DB, no `next/headers`) so it can be unit-tested with
// `node --test`; the request adapters at the bottom are the only Next-aware code.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { config } from './config';

export const ADMIN_COOKIE = 'rw_admin';

/** 12h: long enough for a race weekend day, short enough that a stolen laptop expires. */
export const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

const COOKIE_VERSION = 'v1';
const KEY_CONTEXT = 'rw-admin-cookie/v1/';

/**
 * Constant-time compare that does not leak length and never throws.
 * `timingSafeEqual` requires equal-length buffers, so hash both sides first —
 * the digests are always 32 bytes. (The previous duplicated `isAuthorized`
 * helpers compared lengths in the clear and threw on mismatch.)
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

function cookieKey(secret: string): Buffer {
  return createHash('sha256').update(KEY_CONTEXT + secret, 'utf8').digest();
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', cookieKey(secret)).update(payload, 'utf8').digest('hex');
}

/** Mints a cookie value valid for ADMIN_TTL_MS from `now`. */
export function mintAdminCookie(secret: string, now: number = Date.now()): string {
  const payload = `${COOKIE_VERSION}.${now + ADMIN_TTL_MS}`;
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Fails closed: unset secret, wrong version, malformed, tampered, or expired all
 * return false. The signature is checked before the expiry is trusted.
 */
export function verifyAdminCookie(
  value: string | undefined | null,
  secret: string | undefined | null,
  now: number = Date.now()
): boolean {
  if (!value || !secret) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [version, expiryStr, mac] = parts;
  // The version lives inside the signed payload, so it can't be swapped without
  // invalidating the MAC. Checking it up front just avoids pointless work.
  if (version !== COOKIE_VERSION) return false;
  if (!/^\d+$/.test(expiryStr)) return false;
  if (!safeEqual(mac, sign(`${version}.${expiryStr}`, secret))) return false;
  return Number(expiryStr) > now;
}

export interface AdminCookieOptions {
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  maxAge: number;
  path: string;
}

/**
 * `sameSite: 'strict'` is safe here because admin navigation always starts from
 * within the app (there is no cross-site OAuth bounce like the worker flow has).
 * `secure` follows APP_BASE_URL so local http dev still works.
 */
export function isSecureBaseUrl(baseUrl: string): boolean {
  return baseUrl.startsWith('https://');
}

export function adminCookieOptions(): AdminCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecureBaseUrl(config.appBaseUrl),
    maxAge: Math.floor(ADMIN_TTL_MS / 1000),
    path: '/',
  };
}

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

const THROTTLE_MAX = 10;
const THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const FAILURE_DELAY_MS = 250;

/**
 * In-process fixed-window counter. Honest about its limits: this is per-container
 * state, so N replicas mean N × THROTTLE_MAX attempts, and a restart clears it.
 * It exists to make casual online guessing tedious, not to be a real rate limiter —
 * the actual defense is ADMIN_SECRET entropy (`openssl rand -base64 24`). If we
 * ever run more than one instance, move this to Postgres or a proxy-level limit.
 */
const attempts = new Map<string, { count: number; windowStart: number }>();

export function throttleKey(headers: { get(name: string): string | null }): string {
  // First hop of x-forwarded-for is the client per convention; it is spoofable,
  // which is another reason not to lean on this for security.
  const xff = headers.get('x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  return first || 'unknown';
}

/** Returns false when the caller has exhausted its window. Counts the attempt. */
export function recordAttempt(key: string, now: number = Date.now()): boolean {
  const entry = attempts.get(key);
  if (!entry || now - entry.windowStart >= THROTTLE_WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= THROTTLE_MAX;
}

/** Test seam only — clears the in-process window state. */
export function resetThrottle(): void {
  attempts.clear();
}

/** Small uniform delay on every failed login, to blunt fast automated guessing. */
export function failureDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
}

// ---------------------------------------------------------------------------
// The single decision function
// ---------------------------------------------------------------------------

export type AdminCheck =
  | { ok: true; via: 'cookie' | 'query' }
  | { ok: false; reason: 'unconfigured' | 'unauthenticated' };

export interface AdminCheckInput {
  cookie?: string | null;
  secret?: string | null;
  /**
   * `?secret=` is accepted on `/api/admin/*` only (README curl flows). Pages pass
   * `false` so a secret can't end up in browser history, Referer, or a shared URL.
   */
  allowQuerySecret?: boolean;
}

export function checkAdmin({ cookie, secret, allowQuerySecret = true }: AdminCheckInput): AdminCheck {
  const expected = config.adminSecret;
  if (!expected) return { ok: false, reason: 'unconfigured' };
  if (verifyAdminCookie(cookie, expected)) return { ok: true, via: 'cookie' };
  if (allowQuerySecret && secret && safeEqual(secret, expected)) return { ok: true, via: 'query' };
  return { ok: false, reason: 'unauthenticated' };
}

export function checkAdminRequest(req: NextRequest, allowQuerySecret = true): AdminCheck {
  return checkAdmin({
    cookie: req.cookies.get(ADMIN_COOKIE)?.value,
    secret: req.nextUrl.searchParams.get('secret'),
    allowQuerySecret,
  });
}

/**
 * Route-handler guard: returns a Response to return early, or null to proceed.
 * `unconfigured` gets its own message so a missing ADMIN_SECRET reads as an ops
 * problem rather than a wrong password.
 */
export function requireAdmin(req: NextRequest, allowQuerySecret = true): Response | null {
  const check = checkAdminRequest(req, allowQuerySecret);
  if (check.ok) return null;
  const body =
    check.reason === 'unconfigured'
      ? { error: 'admin not configured: ADMIN_SECRET is not set on the server' }
      : { error: 'forbidden' };
  return new Response(JSON.stringify(body), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}
