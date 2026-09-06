import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bilingualName,
  checkBilingualName,
  checkWriteGuard,
  isValidSku,
  QBO_NAME_MAX_LENGTH,
  WRITE_GUARD_MESSAGES,
  type WriteGuardInput,
} from './catalog';
import { DEMO_CATEGORIES, DEMO_CUSTOMERS, DEMO_PARTS } from './demo-catalog';
import { norm, searchCatalog } from '../search';

// ---------------------------------------------------------------------------
// The write guard. This predicate is the only thing between a demo-seeding script
// and someone's real books, so it gets the most tests in this file.
// ---------------------------------------------------------------------------

const sandbox: WriteGuardInput = {
  environment: 'sandbox',
  companyName: 'Sandbox Company US 09ab',
  confirmed: true,
};

test('write guard: passes only for a confirmed, named sandbox company', () => {
  const result = checkWriteGuard(sandbox);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.companyName, 'Sandbox Company US 09ab');
});

test('write guard: refuses production even when confirmed', () => {
  const result = checkWriteGuard({ ...sandbox, environment: 'production' });
  assert.deepEqual(result, { ok: false, reason: 'production-environment' });
});

test('write guard: production is reported as production, not as "confirm me"', () => {
  // Ordering matters: an operator pointed at live books must not be told to pass --yes.
  const result = checkWriteGuard({ ...sandbox, environment: 'production', confirmed: false });
  assert.equal(result.ok === false && result.reason, 'production-environment');
});

test('write guard: fails closed on any environment that is not exactly "sandbox"', () => {
  for (const environment of ['', 'Sandbox', 'SANDBOX', 'sandbox ', 'staging', 'prod']) {
    const result = checkWriteGuard({ ...sandbox, environment });
    assert.equal(result.ok, false, `environment ${JSON.stringify(environment)} must not pass`);
    assert.equal(result.ok === false && result.reason, 'production-environment');
  }
});

test('write guard: refuses without confirmation', () => {
  assert.deepEqual(checkWriteGuard({ ...sandbox, confirmed: false }), {
    ok: false,
    reason: 'unconfirmed',
  });
});

test('write guard: refuses when the company could not be identified', () => {
  for (const companyName of [null, undefined, '', '   ']) {
    assert.deepEqual(
      checkWriteGuard({ ...sandbox, companyName }),
      { ok: false, reason: 'unknown-company' },
      `companyName ${JSON.stringify(companyName)} should not pass the guard`
    );
  }
});

test('write guard: every refusal reason has an operator-facing message', () => {
  for (const reason of ['production-environment', 'unconfirmed', 'unknown-company'] as const) {
    assert.ok(WRITE_GUARD_MESSAGES[reason].length > 0);
  }
});

// ---------------------------------------------------------------------------
// The bilingual name convention and its 100-character ceiling (design doc §10)
// ---------------------------------------------------------------------------

test('bilingualName joins with the " - " convention', () => {
  assert.equal(bilingualName('11T Sprocket', 'Piñón 11T'), '11T Sprocket - Piñón 11T');
});

test('checkBilingualName accepts a name at exactly the 100-character limit', () => {
  const english = 'A'.repeat(48);
  const spanish = 'B'.repeat(49); // 48 + 3 separator + 49 = 100
  const result = checkBilingualName(english, spanish);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.name.length, QBO_NAME_MAX_LENGTH);
});

test('checkBilingualName rejects one character over the limit, and says by how much', () => {
  const result = checkBilingualName('A'.repeat(48), 'B'.repeat(50));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'too-long');
  assert.equal(result.ok === false && result.reason === 'too-long' && result.length, 101);
});

test('checkBilingualName rejects an empty half — a name must be findable in both languages', () => {
  assert.equal(checkBilingualName('Axle', '  ').ok, false);
  assert.equal(checkBilingualName('', 'Eje').ok, false);
});

test('checkBilingualName trims but does not truncate', () => {
  const result = checkBilingualName('  Spark Plug  ', '  Bujía  ');
  assert.equal(result.ok && result.name, 'Spark Plug - Bujía');
});

// ---------------------------------------------------------------------------
// SKU shape
// ---------------------------------------------------------------------------

test('isValidSku accepts the schemes used by the demo catalog', () => {
  for (const sku of ['AX50-M', 'MG-YEL', 'CH219-L', 'SPR-11T', 'BRK-PAD-F', 'CH-LINK-219']) {
    assert.ok(isValidSku(sku), `${sku} should be valid`);
  }
});

test('isValidSku rejects lower case, spaces, and one-character SKUs', () => {
  for (const sku of ['ax50-m', 'AX50 M', 'A', 'AX_50', 'AX/50', '']) {
    assert.ok(!isValidSku(sku), `${sku} should be invalid`);
  }
});

// ---------------------------------------------------------------------------
// The dataset itself. These assertions are the reason the seeding script's
// pre-flight can never be the first place a bad name is discovered.
// ---------------------------------------------------------------------------

test('every demo part has a valid SKU, a legal bilingual name, and a non-zero price', () => {
  for (const part of DEMO_PARTS) {
    assert.ok(isValidSku(part.sku), `${part.sku}: invalid SKU shape`);
    const name = checkBilingualName(part.en, part.es);
    assert.equal(name.ok, true, `${part.sku}: name rejected (${JSON.stringify(name)})`);
    assert.ok(part.unitPrice > 0, `${part.sku}: price must be greater than zero`);
    assert.ok(DEMO_CATEGORIES.includes(part.category), `${part.sku}: unknown category`);
    assert.ok(part.descEn.length > 0 && part.descEs.length > 0, `${part.sku}: description missing a half`);
  }
});

test('demo SKUs and customer names are unique — a duplicate would be silently adopted on re-run', () => {
  assert.equal(new Set(DEMO_PARTS.map((p) => p.sku)).size, DEMO_PARTS.length);
  assert.equal(new Set(DEMO_CUSTOMERS.map((c) => c.displayName)).size, DEMO_CUSTOMERS.length);
});

test('the dataset is the promised size: 9 categories, ~90 parts, ~16 customers', () => {
  assert.equal(DEMO_CATEGORIES.length, 9);
  assert.ok(DEMO_PARTS.length >= 90, `expected at least 90 parts, got ${DEMO_PARTS.length}`);
  assert.ok(DEMO_CUSTOMERS.length >= 16, `expected at least 16 customers, got ${DEMO_CUSTOMERS.length}`);
  // Every category must actually be populated, or its column is dead weight in the UI.
  for (const category of DEMO_CATEGORIES) {
    assert.ok(DEMO_PARTS.some((p) => p.category === category), `category ${category} has no parts`);
  }
});

test('the dataset carries accents, so §12.2 accent-folding search is genuinely exercised', () => {
  const accented = DEMO_PARTS.filter((p) => norm(p.es) !== p.es.toLowerCase());
  assert.ok(accented.length >= 20, `expected many accented Spanish names, got ${accented.length}`);
  // The three the design doc calls out by example.
  for (const needle of ['Piñón', 'Neumáticos', 'dirección']) {
    assert.ok(
      DEMO_PARTS.some((p) => norm(`${p.es} ${p.descEs}`).includes(norm(needle))),
      `no demo part carries "${needle}"`
    );
  }
});

test('an accent-free query finds the accented part in the real dataset', () => {
  const catalog = DEMO_PARTS.map((p) => ({
    id: p.sku,
    sku: p.sku,
    name: bilingualName(p.en, p.es),
    description: `${p.descEn} / ${p.descEs}`,
  }));

  // Typed without the accent, and shouted — both must find the sprockets.
  for (const typed of ['pinon', 'PIÑÓN', 'Piñon']) {
    const hits = searchCatalog(catalog, typed);
    assert.ok((hits?.length ?? 0) >= 3, `"${typed}" found ${hits?.length ?? 0} sprockets`);
    assert.ok(hits!.every((h) => h.sku.startsWith('SPR-')));
  }

  // English and Spanish for the same concept reach the same parts.
  const axleSkus = new Set(searchCatalog(catalog, 'axle')!.map((h) => h.sku));
  for (const sku of searchCatalog(catalog, 'eje')!.map((h) => h.sku)) {
    assert.ok(axleSkus.has(sku), `"eje" hit ${sku} which "axle" did not`);
  }

  // A bare SKU fragment and a bare part number are both usable searches (§12.3).
  assert.ok(searchCatalog(catalog, 'AX50')!.length >= 4);
  assert.ok(searchCatalog(catalog, '219')!.length >= 4);
});
