// Admin auth primitives — design doc §8, plan §2, M3 named accounts.
//
// The cookie names a person: `rw_admin = v2.<adminId>.<tokenVersion>.<expiryMs>.<hmacHex>`,
// HMAC keyed off ADMIN_SECRET over all four fields. It is still not a session record —
// there is no session table — but it is no longer anonymous, and it carries the account's
// `token_version` so one admin's sessions can be revoked without touching anyone else's
// (src/admin-session.ts does that check). Rotating ADMIN_SECRET still invalidates every
// outstanding cookie for everyone; that property is deliberate and unchanged.
//
// Verification is two steps on purpose:
//   1. here — signature + expiry, pure, unit-testable, no I/O;
//   2. src/admin-session.ts — the account still exists, is active, and matches the version.
// Splitting them keeps this file free of `pg` and `next/headers` so `node --test` can
// exercise the crypto directly.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config';

export const ADMIN_COOKIE = 'rw_admin';

/** 12h: long enough for a race weekend day, short enough that a stolen laptop expires. */
export const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

const COOKIE_VERSION = 'v2';
const KEY_CONTEXT = 'rw-admin-cookie/v1/';

/**
 * Constant-time compare that does not leak length and never throws.
 * `timingSafeEqual` requires equal-length buffers, so hash both sides first —
 * the digests are always 32 bytes.
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

/** Who the cookie claims to be. Claims, not facts — the DB decides (src/admin-session.ts). */
export interface AdminCookieClaims {
  adminId: number;
  tokenVersion: number;
  expiresAt: number;
}

/** Mints a cookie value valid for ADMIN_TTL_MS from `now`. */
export function mintAdminCookie(
  secret: string,
  claims: { adminId: number; tokenVersion: number },
  now: number = Date.now()
): string {
  const payload = `${COOKIE_VERSION}.${claims.adminId}.${claims.tokenVersion}.${now + ADMIN_TTL_MS}`;
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Fails closed: unset secret, wrong version, malformed, tampered, or expired all return
 * null. The signature is checked before any field is trusted — including the admin id, which
 * is why a cookie can't be re-pointed at another account.
 *
 * Returns the claims rather than a boolean because every caller now needs the identity.
 */
export function verifyAdminCookie(
  value: string | undefined | null,
  secret: string | undefined | null,
  now: number = Date.now()
): AdminCookieClaims | null {
  if (!value || !secret) return null;
  const parts = value.split('.');
  if (parts.length !== 5) return null;
  const [version, adminIdStr, tokenVersionStr, expiryStr, mac] = parts;
  // The version lives inside the signed payload, so it can't be swapped without
  // invalidating the MAC. Checking it up front just avoids pointless work — and makes a
  // leftover v1 cookie (anonymous, no identity) an immediate reject rather than a parse error.
  if (version !== COOKIE_VERSION) return null;
  if (!/^\d+$/.test(adminIdStr) || !/^\d+$/.test(tokenVersionStr) || !/^\d+$/.test(expiryStr)) {
    return null;
  }
  const payload = `${version}.${adminIdStr}.${tokenVersionStr}.${expiryStr}`;
  if (!safeEqual(mac, sign(payload, secret))) return null;
  const expiresAt = Number(expiryStr);
  if (expiresAt <= now) return null;
  return { adminId: Number(adminIdStr), tokenVersion: Number(tokenVersionStr), expiresAt };
}

/**
 * `?secret=` — ADMIN_SECRET presented directly. Accepted only on the read/script endpoints
 * (export, sync), never on anything that mutates: a write needs a named actor for the audit
 * row (§23 Rule 4), and this path has no identity to give.
 */
export function matchesAdminSecret(provided: string | undefined | null): boolean {
  const expected = config.adminSecret;
  if (!expected || !provided) return false;
  return safeEqual(provided, expected);
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
 * the actual defense is scrypt on the stored password plus ADMIN_SECRET entropy. If we
 * ever run more than one instance, move this to Postgres or a proxy-level limit.
 *
 * Keyed by IP, not by username: keying on the username would let anyone lock a named
 * manager out of their own account by guessing at their handle.
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
