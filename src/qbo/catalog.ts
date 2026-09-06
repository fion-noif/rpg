// Pure helpers for building a QuickBooks parts catalog: the sandbox-only safety guard, the
// bilingual `Name` convention and its hard length limit, and SKU shape validation.
//
// Nothing here touches the network or the database. That is deliberate — the guard predicate
// in particular is the one thing between a demo-seeding script and someone's real books, so
// it is a pure function with its own tests rather than an `if` buried in a script.

/**
 * QuickBooks rejects an Item whose `Name` exceeds 100 characters (design doc §10). The
 * bilingual convention doubles every name, so this is not a theoretical limit — it is the
 * one that bites. Overflow Spanish belongs in `Description`, per §10.
 */
export const QBO_NAME_MAX_LENGTH = 100;

/** QuickBooks rejects an Item whose `Sku` exceeds 100 characters. */
export const QBO_SKU_MAX_LENGTH = 100;

/**
 * The permanent technical identifier (§9/§10): upper-case letters, digits, `-` and `#`.
 * Narrow on purpose — a SKU is typed on a phone, read aloud across a paddock, and scanned
 * from a barcode (§13), so the character set is the one that survives all three.
 */
const SKU_RE = /^[A-Z0-9#][A-Z0-9#-]{1,31}$/;

export function isValidSku(sku: string): boolean {
  return SKU_RE.test(sku) && sku.length <= QBO_SKU_MAX_LENGTH;
}

/**
 * The `English Name - Nombre Español` convention (design doc §10). A single separator
 * so a worker in either language finds the same row with one substring match, and so the
 * bilingual text is what the customer sees on the QuickBooks invoice.
 */
export function bilingualName(english: string, spanish: string): string {
  return `${english} - ${spanish}`;
}

export type NameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: 'too-long'; name: string; length: number }
  | { ok: false; reason: 'empty' };

/**
 * Build a bilingual item name and refuse to hand back one QuickBooks will reject.
 *
 * Fails loudly rather than truncating: a silently clipped name loses the Spanish half, which
 * is precisely the half §12.2 search depends on, and the loss would only surface as "the
 * Spanish-speaking worker can't find the part" weeks later.
 */
export function checkBilingualName(english: string, spanish: string): NameCheck {
  const en = english.trim();
  const es = spanish.trim();
  if (!en || !es) return { ok: false, reason: 'empty' };
  const name = bilingualName(en, es);
  if (name.length > QBO_NAME_MAX_LENGTH) {
    return { ok: false, reason: 'too-long', name, length: name.length };
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// The sandbox-only write guard
// ---------------------------------------------------------------------------

/**
 * What the guard was given. Taking a plain record rather than reading `config` and
 * `process.argv` directly is what makes the predicate testable — and the predicate is the
 * part that has to be right.
 */
export interface WriteGuardInput {
  /**
   * `config.environment`. Deliberately typed `string`, not `'sandbox' | 'production'`: the
   * guard's rule is "must be exactly `sandbox`", so a third value nobody anticipated — a
   * typo, a new Intuit environment name — has to *fail closed* rather than fail to compile.
   */
  environment: string;
  /** `CompanyInfo.CompanyName` as QuickBooks reports it, for the operator to eyeball. */
  companyName: string | null | undefined;
  /** True when `--yes` was passed or an interactive confirm was answered. */
  confirmed: boolean;
}

export type WriteGuardResult =
  | { ok: true; companyName: string }
  | { ok: false; reason: 'production-environment' | 'unconfirmed' | 'unknown-company' };

/**
 * Decide whether a catalog-seeding script may write to QuickBooks.
 *
 * Three independent conditions, because each catches a different accident:
 *
 *  - `environment === 'sandbox'`. The blunt instrument. A future operator who copies a
 *    production `.env` into place gets a refusal, not 90 new items in the real company.
 *  - A company name came back. If `companyInfo()` failed or returned nothing we do not know
 *    *what* we are pointed at, and "unknown" is not a safe default for a bulk write.
 *  - `confirmed`. `QBO_ENVIRONMENT` is one line in a file; a human saying so is a second,
 *    independent signal. The script prints the company name first so the confirmation is
 *    informed rather than reflexive.
 *
 * Production is checked first so the refusal message names the real problem instead of
 * telling someone pointed at their live books to pass `--yes`.
 */
export function checkWriteGuard(input: WriteGuardInput): WriteGuardResult {
  if (input.environment !== 'sandbox') return { ok: false, reason: 'production-environment' };
  const companyName = (input.companyName ?? '').trim();
  if (!companyName) return { ok: false, reason: 'unknown-company' };
  if (!input.confirmed) return { ok: false, reason: 'unconfirmed' };
  return { ok: true, companyName };
}

export const WRITE_GUARD_MESSAGES: Record<
  Exclude<WriteGuardResult, { ok: true }>['reason'],
  string
> = {
  'production-environment':
    'Refusing to run: QBO_ENVIRONMENT is not "sandbox". This script bulk-creates and ' +
    'deactivates master data and must never touch a production company.',
  'unknown-company':
    'Refusing to run: QuickBooks did not return a company name, so the target company ' +
    'cannot be identified. Check the OAuth tokens (npm run auth) and try again.',
  unconfirmed:
    'Refusing to run without confirmation. Re-run with --yes once the company name above ' +
    'is the sandbox you meant.',
};
