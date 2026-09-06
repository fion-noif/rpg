// Admin password hashing (M3). scrypt from node:crypto — memory-hard, no dependency,
// and the parameters travel with the digest so they can be raised later without a flag day.
//
// Stored form: `scrypt$<saltHex>$<hashHex>`. Pure (no DB, no Next) so it unit-tests under
// `node --test`; src/admin/admins.ts is the only caller that persists the result.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCHEME = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** node's defaults: N=16384, r=8, p=1 — ~50ms per hash, which is the point. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password, salt, KEY_BYTES);
  return `${SCHEME}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Fails closed and never throws: a null, malformed, wrong-scheme or non-hex stored value
 * is a `false`, not a 500. The comparison is `timingSafeEqual` over two equal-length
 * derived keys, so it leaks neither the digest nor its length.
 */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [scheme, saltHex, hashHex] = parts;
  if (scheme !== SCHEME) return false;
  if (!/^[0-9a-f]+$/.test(saltHex) || !/^[0-9a-f]+$/.test(hashHex)) return false;
  if (hashHex.length !== KEY_BYTES * 2) return false;

  const expected = Buffer.from(hashHex, 'hex');
  try {
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    // scryptSync throws on absurd parameters (e.g. an empty salt); treat as a mismatch.
    return false;
  }
}

// Ambiguity-free alphabet: no 0/O, 1/l/I. These passwords get read off a screen and typed
// into a phone by someone who was just handed them, so a misread costs a support round-trip.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A one-time password for a newly created or reset account, ~71 bits at 12 characters.
 * Same discipline as the worker magic-link token (src/workers.ts newToken): generated from
 * `randomBytes`, shown exactly once, never placed in a URL.
 *
 * Rejection sampling rather than `% ALPHABET.length`, which would bias the first few
 * characters — cheap to do right, and this is a credential.
 */
export function generateTempPassword(length = 12): string {
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= max) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}
