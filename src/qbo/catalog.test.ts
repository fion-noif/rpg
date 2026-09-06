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
import {
  DEMO_CATEGORIES,
  DEMO_CUSTOMERS,
  DEMO_PARTS,
  DEMO_SERVICE_CATEGORY,
  DEMO_SERVICES,
  STOCK_ITEMS,
  STOCK_SERVICE_ITEMS,
} from './demo-catalog';
import {
  isManagerOnlyCategory,
  isWorkerVisibleItem,
  managerOnlyItemSql,
  managerSellableItemSql,
  MANAGER_ONLY_CATEGORIES,
  workerVisibleItemSql,
} from '../catalog';
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

// ---------------------------------------------------------------------------
// The manager-only service items (owner's decision 09/06/2026). These assertions
// are the ones that fire if somebody adds a service without a day rate in its
// name, or files it under a category the app does not hide.
// ---------------------------------------------------------------------------

test('every demo service has a valid SKU, a legal bilingual name, and a non-zero day rate', () => {
  for (const service of DEMO_SERVICES) {
    assert.ok(isValidSku(service.sku), `${service.sku}: invalid SKU shape`);
    const name = checkBilingualName(service.en, service.es);
    assert.ok(name.ok, `${service.sku}: ${JSON.stringify(name)}`);
    assert.ok(name.ok && name.name.length <= QBO_NAME_MAX_LENGTH);
    assert.ok(service.dayRate > 0, `${service.sku}: day rate must be positive`);
  }
});

test('service SKUs follow the SVC-*-DAY scheme and are the three Mike named', () => {
  assert.deepEqual(
    DEMO_SERVICES.map((s) => s.sku),
    ['SVC-TEAM-DAY', 'SVC-MECH-DAY', 'SVC-ENGINE-DAY']
  );
  // The `-DAY` suffix is the SKU-level statement of the billing unit, so a future service
  // priced some other way cannot join this list without the mismatch being obvious.
  for (const service of DEMO_SERVICES) assert.ok(service.sku.endsWith('-DAY'), service.sku);
});

test('a service name states its unit in both languages, so an invoice line is unambiguous', () => {
  for (const service of DEMO_SERVICES) {
    assert.match(service.en, /\(per day\)$/, `${service.sku}: English half must say "(per day)"`);
    assert.match(service.es, /\(por día\)$/, `${service.sku}: Spanish half must say "(por día)"`);
    // §10's convention, and what the description is for: the unit spelled out again where a
    // bookkeeper reads it.
    assert.match(service.descEn, /race day/, service.sku);
    assert.match(service.descEs, /día de carrera/, service.sku);
  }
});

test('services share the SKU namespace with parts and collide with none of them', () => {
  const partSkus = new Set(DEMO_PARTS.map((p) => p.sku));
  for (const service of DEMO_SERVICES) {
    assert.ok(!partSkus.has(service.sku), `${service.sku} collides with a part`);
  }
  assert.equal(new Set(DEMO_SERVICES.map((s) => s.sku)).size, DEMO_SERVICES.length);
});

test('team support is the priciest service, and every day rate is a plausible one', () => {
  const rates = new Map(DEMO_SERVICES.map((s) => [s.sku, s.dayRate]));
  const team = rates.get('SVC-TEAM-DAY')!;
  for (const [sku, rate] of rates) {
    if (sku !== 'SVC-TEAM-DAY') assert.ok(rate < team, `${sku} (${rate}) should be under team support`);
    assert.ok(rate >= 250 && rate <= 500, `${sku}: ${rate} is outside the plausible day-rate band`);
  }
});

test('the service category is not named "Services" — QuickBooks Item names are unique', () => {
  // Verified against the sandbox: creating a Category named `Services` returns fault 6000,
  // because Intuit's stock demo ships an undeletable Item with that exact name (Id 1).
  assert.equal(DEMO_SERVICE_CATEGORY, 'Race Services');
  assert.ok(!(DEMO_CATEGORIES as readonly string[]).includes(DEMO_SERVICE_CATEGORY));
  assert.ok(!STOCK_ITEMS.some((i) => i.name === DEMO_SERVICE_CATEGORY));
});

test('the seeder files services under exactly the category the app hides', () => {
  // The one assertion tying the two halves of the feature together: if these ever disagree,
  // services get created in QuickBooks and then shown to workers anyway.
  assert.ok((MANAGER_ONLY_CATEGORIES as readonly string[]).includes(DEMO_SERVICE_CATEGORY));
});

test('the two undeletable stock service items are the ones marked for re-parenting', () => {
  assert.deepEqual(STOCK_SERVICE_ITEMS, [
    { id: '1', name: 'Services' },
    { id: '2', name: 'Hours' },
  ]);
  // They must also stay in the deactivation allow-list: --deactivate-demo tries and reports
  // the refusal, which is how an operator learns the re-parent is what protects them.
  for (const item of STOCK_SERVICE_ITEMS) {
    assert.ok(STOCK_ITEMS.some((s) => s.id === item.id && s.name === item.name), item.name);
  }
});

// ---------------------------------------------------------------------------
// The visibility predicate, and its agreement with the SQL it mirrors. Defined
// in one place (src/catalog.ts) and reused at four call sites, so this is where
// the rule itself is pinned down.
// ---------------------------------------------------------------------------

interface VisibilityCase {
  label: string;
  row: { active: boolean; sku: string | null; type: string | null; category: string | null };
  workerVisible: boolean;
  managerOnly: boolean;
}

const VISIBILITY_CASES: VisibilityCase[] = [
  {
    label: 'an ordinary racing part',
    row: { active: true, sku: 'AX50-M', type: 'NonInventory', category: 'Axles' },
    workerVisible: true,
    managerOnly: false,
  },
  {
    label: 'a part with no category yet',
    row: { active: true, sku: 'AX50-M', type: 'NonInventory', category: null },
    workerVisible: true,
    managerOnly: false,
  },
  {
    label: 'a manager-only service',
    row: { active: true, sku: 'SVC-MECH-DAY', type: 'Service', category: 'Race Services' },
    workerVisible: false,
    managerOnly: true,
  },
  {
    label: "Intuit's stock Services item: no SKU, no category",
    row: { active: true, sku: null, type: 'Service', category: null },
    workerVisible: false,
    managerOnly: false,
  },
  {
    label: 'the same stock item once re-parented under Race Services',
    row: { active: true, sku: null, type: 'Service', category: 'Race Services' },
    workerVisible: false,
    managerOnly: true,
  },
  {
    label: 'an inactive part',
    row: { active: false, sku: 'AX50-M', type: 'NonInventory', category: 'Axles' },
    workerVisible: false,
    managerOnly: false,
  },
  {
    label: 'an inactive service',
    row: { active: false, sku: 'SVC-MECH-DAY', type: 'Service', category: 'Race Services' },
    workerVisible: false,
    managerOnly: false,
  },
  {
    label: 'a Category folder, which is not sellable at all',
    row: { active: true, sku: null, type: 'Category', category: null },
    workerVisible: false,
    managerOnly: false,
  },
];

test('isWorkerVisibleItem hides services, SKU-less stock items, folders and inactive rows', () => {
  for (const c of VISIBILITY_CASES) {
    assert.equal(isWorkerVisibleItem(c.row), c.workerVisible, c.label);
  }
});

test('isManagerOnlyCategory is exactly the MANAGER_ONLY_CATEGORIES membership test', () => {
  for (const category of MANAGER_ONLY_CATEGORIES) assert.ok(isManagerOnlyCategory(category));
  // 'Services' and 'race services' in particular: the stock item's name is not the category,
  // and the comparison is not case-folded (QuickBooks category names are what they are).
  for (const category of [null, undefined, '', 'Axles', 'Services', 'race services']) {
    assert.ok(!isManagerOnlyCategory(category), `${category} must not be manager-only`);
  }
});

test('worker-visible and manager-only are disjoint, and neither is empty', () => {
  // `managerSellableItemSql` is literally the OR of the two, so the manager seeing a superset
  // of the worker's catalogue is true by construction; this pins down that the two halves of
  // that union never overlap, which is what makes "parts plus services" a clean split.
  for (const c of VISIBILITY_CASES) {
    if (c.workerVisible) assert.ok(!c.managerOnly, `${c.label} cannot be both`);
  }
  assert.ok(VISIBILITY_CASES.some((c) => c.workerVisible));
  assert.ok(VISIBILITY_CASES.some((c) => c.managerOnly));
  assert.ok(managerSellableItemSql().includes(workerVisibleItemSql()));
  assert.ok(managerSellableItemSql().includes(managerOnlyItemSql()));
});

test('the SQL fragments qualify every column when given a table alias', () => {
  // The popular-parts query joins `items` as `i`, so an unqualified `active` there would be
  // an ambiguous-column error at runtime — a page-level 500 no other test would catch.
  const aliased = workerVisibleItemSql('i');
  const withoutQualified = aliased.replace(/\bi\.\w+/g, '');
  for (const column of ['active', 'type', 'sku', 'category']) {
    assert.match(aliased, new RegExp(`\\bi\\.${column}\\b`), `${column} is not aliased`);
    assert.ok(!new RegExp(`\\b${column}\\b`).test(withoutQualified), `${column} appears unqualified`);
  }
  // And no alias means no prefix, so the fragment still drops into a bare `FROM items`.
  assert.ok(!workerVisibleItemSql().includes('i.'));
});

test('the SQL fragments carry no bind placeholders, so they compose into any query', () => {
  for (const sql of [workerVisibleItemSql(), managerOnlyItemSql(), managerSellableItemSql()]) {
    assert.ok(!/\$\d/.test(sql), sql);
  }
});

test('the manager-only category is single-quote-safe in SQL', () => {
  // The list is code-owned, never request-derived, so it is inlined rather than bound. That
  // is only safe while it stays escaped — this assertion keeps a future "Mike's Services"
  // from becoming a syntax error or worse.
  for (const category of MANAGER_ONLY_CATEGORIES) {
    assert.ok(
      managerOnlyItemSql().includes(`'${category.replace(/'/g, "''")}'`),
      `${category} is not quoted as expected`
    );
  }
});
