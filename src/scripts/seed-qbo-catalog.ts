// Seed the QuickBooks *sandbox* with a realistic karting catalog: 9 part categories,
// ~95 priced bilingual parts with SKUs, one manager-only `Race Services` category with three
// per-day service items, and 16 customers. Optionally deactivates Intuit's
// stock landscaping demo records and deletes every invoice, so a tester opening the app sees
// only racing data and only invoices they created themselves.
//
// Usage:
//   npm run seed-qbo -- --yes
//   npm run seed-qbo -- --yes --deactivate-demo --purge-invoices
//
// Idempotent: parts are matched by Sku, customers by DisplayName, categories by Name. A
// re-run adopts what exists and creates nothing new. Every flag is a no-op on re-run.
//
// QuickBooks is master data (design doc §3) — the app only ever reads it. This script is the
// one exception, and it is a demo-seeding tool, which is exactly why the guard below exists.
import { config } from '../config';
import { pool } from '../db';
import { companyInfo, queryAll, create, update, QboError } from '../qbo/client';
import {
  checkBilingualName,
  checkWriteGuard,
  isValidSku,
  QBO_NAME_MAX_LENGTH,
  WRITE_GUARD_MESSAGES,
} from '../qbo/catalog';
import {
  DEMO_CATEGORIES,
  DEMO_CUSTOMERS,
  DEMO_PARTS,
  DEMO_SERVICE_CATEGORY,
  DEMO_SERVICES,
  STOCK_CUSTOMERS,
  STOCK_ITEMS,
  STOCK_SERVICE_ITEMS,
} from '../qbo/demo-catalog';
import { INVOICES_ONLY, purgeTransactions, STOCK_DEMO_TRANSACTIONS } from '../qbo/purge';

/**
 * Every seeded part is a NonInventory item booked to this income account. §28 n.27 requires
 * NonInventory or Service for a QuickBooks *Essentials* subscription — Inventory items are a
 * Plus feature, and four of the stock demo items are Inventory, which is part of why the
 * stock catalog undercuts the app. `79` is "Sales of Product Income" in this sandbox.
 */
const INCOME_ACCOUNT_REF = '79';

/**
 * Service items book to a *different* account from parts: `1` is "Services"
 * (Income / ServiceFeeIncome) in this sandbox, which is what service revenue is. Not `51`
 * "Labor" — that is Income/OtherPrimaryIncome, and it would be wrong for the engine lease,
 * which is rental income and not labour at all. One account for all three keeps the P&L
 * split "parts vs services", which is the split Mike actually reads.
 */
const SERVICE_INCOME_ACCOUNT_REF = '1';

/** Every category created, part folders plus the one manager-only service folder. */
const ALL_CATEGORIES: readonly string[] = [...DEMO_CATEGORIES, DEMO_SERVICE_CATEGORY];

const args = process.argv.slice(2);
const flags = {
  yes: args.includes('--yes'),
  deactivateDemo: args.includes('--deactivate-demo'),
  purgeInvoices: args.includes('--purge-invoices'),
  // Wider than --purge-invoices, and separate from it on purpose: it deletes Payments,
  // Estimates, billable Purchases and the rest of Intuit's stock transaction data. Needed
  // because QuickBooks refuses to deactivate a customer that still carries a balance or an
  // unbilled charge, and those rows are where both come from — so without this, 13 of the
  // 29 stock customers stay in the worker's picker no matter what --deactivate-demo does.
  purgeStockTxns: args.includes('--purge-stock-txns'),
};

function die(message: string): never {
  console.error(message);
  process.exitCode = 1;
  throw new ExitError();
}

/** Thrown to unwind to the single `pool.end()` at the bottom rather than leaking a connection. */
class ExitError extends Error {}

// ---------------------------------------------------------------------------
// Pre-flight: validate the dataset before a single byte goes over the wire
// ---------------------------------------------------------------------------

/**
 * Validate the whole dataset up front. A partial catalog is worse than none: the operator
 * has to work out which of 95 parts landed, and the SKUs that did land are now adopted by
 * a re-run, so a typo becomes permanent. So every name, SKU and price is checked before the
 * first create.
 */
function validateDataset(): void {
  const problems: string[] = [];
  const seenSkus = new Set<string>();

  for (const part of DEMO_PARTS) {
    if (!isValidSku(part.sku)) problems.push(`SKU "${part.sku}" is not a valid SKU shape.`);
    if (seenSkus.has(part.sku)) problems.push(`SKU "${part.sku}" is duplicated in the dataset.`);
    seenSkus.add(part.sku);

    // The 100-character ceiling (§10). Loud, not truncating: a clipped name loses the
    // Spanish half, which is the half §12.2 search depends on.
    const name = checkBilingualName(part.en, part.es);
    if (!name.ok) {
      problems.push(
        name.reason === 'too-long'
          ? `SKU ${part.sku}: name is ${name.length} chars, over the QuickBooks limit of ${QBO_NAME_MAX_LENGTH}: "${name.name}"`
          : `SKU ${part.sku}: name has an empty English or Spanish half.`
      );
    }

    // No $0 parts: the manager's review screen exists to catch mistakes, and a column of
    // zeros hides them.
    if (!(part.unitPrice > 0)) problems.push(`SKU ${part.sku}: unit price must be greater than zero.`);
    if (!DEMO_CATEGORIES.includes(part.category)) problems.push(`SKU ${part.sku}: unknown category "${part.category}".`);
  }

  // Services go through exactly the same gauntlet as parts — same SKU shape, same
  // bilingual-name rule, same 100-character ceiling, same no-$0 rule — because they are the
  // same QuickBooks Item and land on the same customer invoice. The SKU namespace is shared
  // too, so `seenSkus` carries over and a service colliding with a part is caught here.
  for (const service of DEMO_SERVICES) {
    if (!isValidSku(service.sku)) problems.push(`SKU "${service.sku}" is not a valid SKU shape.`);
    if (seenSkus.has(service.sku)) problems.push(`SKU "${service.sku}" is duplicated in the dataset.`);
    seenSkus.add(service.sku);

    const name = checkBilingualName(service.en, service.es);
    if (!name.ok) {
      problems.push(
        name.reason === 'too-long'
          ? `SKU ${service.sku}: name is ${name.length} chars, over the QuickBooks limit of ${QBO_NAME_MAX_LENGTH}: "${name.name}"`
          : `SKU ${service.sku}: name has an empty English or Spanish half.`
      );
    }

    if (!(service.dayRate > 0)) problems.push(`SKU ${service.sku}: day rate must be greater than zero.`);
  }

  const seenNames = new Set<string>();
  for (const customer of DEMO_CUSTOMERS) {
    if (seenNames.has(customer.displayName)) problems.push(`Customer "${customer.displayName}" is duplicated.`);
    seenNames.add(customer.displayName);
  }

  if (problems.length > 0) {
    console.error(`Dataset is invalid — nothing was sent to QuickBooks. ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    die('Fix src/qbo/demo-catalog.ts and re-run.');
  }
}

// ---------------------------------------------------------------------------
// Idempotent create-or-adopt
// ---------------------------------------------------------------------------

interface Counts {
  created: number;
  adopted: number;
}

async function seedCategories(): Promise<{ ids: Map<string, string>; counts: Counts }> {
  // Category items are Items with Type='Category'; src/qbo/sync.ts reads `ParentRef.name`
  // into `items.category`, so parts must hang off these for the category column to populate.
  const existing = await queryAll('Item', "Type = 'Category' and Active in (true, false)");
  const byName = new Map<string, any>(existing.map((i) => [i.Name, i]));
  const ids = new Map<string, string>();
  const counts: Counts = { created: 0, adopted: 0 };

  for (const name of ALL_CATEGORIES) {
    const found = byName.get(name);
    if (found) {
      ids.set(name, found.Id);
      counts.adopted += 1;
      continue;
    }
    const made = await create('Item', { Name: name, Type: 'Category' });
    ids.set(name, made.Id);
    counts.created += 1;
    console.log(`  + category ${name} (Id ${made.Id})`);
  }
  return { ids, counts };
}

async function seedParts(categoryIds: Map<string, string>): Promise<Counts> {
  const existing = await queryAll('Item', 'Active in (true, false)');
  const bySku = new Map<string, any>(existing.filter((i) => i.Sku).map((i) => [i.Sku, i]));
  const counts: Counts = { created: 0, adopted: 0 };

  for (const part of DEMO_PARTS) {
    if (bySku.has(part.sku)) {
      counts.adopted += 1;
      continue;
    }
    const name = checkBilingualName(part.en, part.es);
    if (!name.ok) die(`Unreachable: SKU ${part.sku} failed validation after the pre-flight passed.`);

    const made = await create('Item', {
      Name: name.name,
      Sku: part.sku,
      // Bilingual description too (§10): it is what carries the Spanish detail that would
      // not fit in the 100-character name, and src/search.ts searches it.
      Description: `${part.descEn} / ${part.descEs}`,
      Type: 'NonInventory',
      IncomeAccountRef: { value: INCOME_ACCOUNT_REF },
      UnitPrice: part.unitPrice,
      // Non-taxable on purpose. The app computes its running total and `charge_batch_lines`
      // as sum(qty * unit_price) and sends that as the invoice `Amount` (src/qbo/invoice.ts).
      // Sales tax is applied by QuickBooks on top, so a taxable part makes the invoice
      // `TotalAmt` disagree with the number the manager approved — and the approved number is
      // the amount of record (§23 Rule 4). Tax is not covered by the design doc at all; until
      // it is, parts stay non-taxable so the two figures reconcile exactly.
      Taxable: false,
      SubItem: true,
      ParentRef: { value: categoryIds.get(part.category) },
      Active: true,
    });
    counts.created += 1;
    console.log(`  + ${part.sku.padEnd(15)} ${made.Name}`);
  }
  return counts;
}

/**
 * The three manager-only service items (owner's decision, 09/06/2026: invoices may include
 * team support, a mechanic and an engine lease, billed in whole days).
 *
 * Filed under the `Race Services` category, which is the *only* thing that makes them
 * manager-only — the app reads `items.category` and hides them from workers (src/catalog.ts).
 * Nothing about the item itself is special, which is the point: a future service is a
 * QuickBooks entry Mike makes himself, with no app change.
 *
 * Idempotent by SKU like the parts, and sharing the same `bySku` namespace, so a re-run
 * adopts all three and creates nothing.
 */
async function seedServices(categoryIds: Map<string, string>): Promise<Counts> {
  const existing = await queryAll('Item', 'Active in (true, false)');
  const bySku = new Set<string>(existing.filter((i) => i.Sku).map((i) => i.Sku));
  const counts: Counts = { created: 0, adopted: 0 };
  const parentId = categoryIds.get(DEMO_SERVICE_CATEGORY);
  if (!parentId) die(`Unreachable: category "${DEMO_SERVICE_CATEGORY}" was neither created nor adopted.`);

  for (const service of DEMO_SERVICES) {
    if (bySku.has(service.sku)) {
      counts.adopted += 1;
      continue;
    }
    const name = checkBilingualName(service.en, service.es);
    if (!name.ok) die(`Unreachable: SKU ${service.sku} failed validation after the pre-flight passed.`);

    const made = await create('Item', {
      Name: name.name,
      Sku: service.sku,
      // The unit is spelled out in both languages here as well as in the name: this is the
      // text a bookkeeper reads in QuickBooks when they wonder what "× 3" meant.
      Description: `${service.descEn} / ${service.descEs}`,
      Type: 'Service',
      IncomeAccountRef: { value: SERVICE_INCOME_ACCOUNT_REF },
      // `UnitPrice` is the price of ONE RACE DAY. Quantity on the invoice line is therefore
      // a number of days, and days are whole — which is why nothing in the app needs
      // fractional quantities (`validateQty` stays integer-only).
      UnitPrice: service.dayRate,
      // Non-taxable, and for these it is not a workaround but the owner's billing model:
      // prices quoted to customers are tax-inclusive and RPG remits tax separately, so the
      // app must never compute tax. See design doc §28 n.28.
      Taxable: false,
      SubItem: true,
      ParentRef: { value: parentId },
      Active: true,
    });
    counts.created += 1;
    console.log(`  + ${service.sku.padEnd(15)} ${made.Name}  $${service.dayRate}/day`);
  }
  return counts;
}

/**
 * Re-file Intuit's two undeletable stock service items under `Race Services`.
 *
 * `Services` (Id 1) and `Hours` (Id 2) cannot be deactivated — they are the company's
 * default sales product and default time-activity service, and QuickBooks refuses. So
 * instead of fighting that, reclassify them: once their category is `Race Services` they are
 * manager-only like the real services, which is a defensible place for them to sit rather
 * than two unpriced rows in a worker's parts list.
 *
 * A refusal is reported and tolerated, not thrown. `WORKER_VISIBLE_ITEM_SQL` requires a SKU
 * and neither of these has one, so workers are protected either way; this is tidiness on top
 * of the real defence, and it must not be able to fail a seeding run.
 */
async function reparentStockServices(
  categoryIds: Map<string, string>
): Promise<{ moved: number; already: number; skipped: number; refused: string[] }> {
  const parentId = categoryIds.get(DEMO_SERVICE_CATEGORY);
  if (!parentId) die(`Unreachable: category "${DEMO_SERVICE_CATEGORY}" was neither created nor adopted.`);

  const items = await queryAll('Item', 'Active in (true, false)');
  const byId = new Map<string, any>(items.map((i) => [i.Id, i]));
  const result = { moved: 0, already: 0, skipped: 0, refused: [] as string[] };

  for (const target of STOCK_SERVICE_ITEMS) {
    const record = byId.get(target.id);
    // Same (id, name) both-must-match belt as deactivateStock, and for the same reason: if
    // ids ever shifted we would be re-parenting some *other* item, which for a real racing
    // part would hide it from every worker.
    if (!record || stripDeletedSuffix(record.Name) !== target.name) {
      console.log(`  ? Item ${target.id} (${target.name}) not found or renamed — skipped`);
      result.skipped += 1;
      continue;
    }
    if (record.ParentRef?.value === parentId) {
      result.already += 1; // re-run is a no-op
      continue;
    }
    try {
      // Sparse update: SubItem + ParentRef only. Everything else about these two items is
      // Intuit's and stays Intuit's.
      await update('Item', {
        Id: record.Id,
        SyncToken: record.SyncToken,
        sparse: true,
        SubItem: true,
        ParentRef: { value: parentId },
      });
      console.log(`  → moved ${target.name} under ${DEMO_SERVICE_CATEGORY}`);
      result.moved += 1;
    } catch (err) {
      const message =
        err instanceof QboError ? (err.fault?.detail ?? err.fault?.message ?? err.message) : String(err);
      console.log(`  ! ${target.name} could not be re-parented: ${message}`);
      console.log(`    (harmless: it has no SKU, so workers cannot see it either way)`);
      result.refused.push(`${target.name}: ${message}`);
    }
  }
  return result;
}

async function seedCustomers(): Promise<Counts> {
  const existing = await queryAll('Customer', 'Active in (true, false)');
  const byName = new Set<string>(existing.map((c) => c.DisplayName));
  const counts: Counts = { created: 0, adopted: 0 };

  for (const customer of DEMO_CUSTOMERS) {
    if (byName.has(customer.displayName)) {
      counts.adopted += 1;
      continue;
    }
    const made = await create('Customer', {
      DisplayName: customer.displayName,
      ...(customer.person ? { GivenName: customer.person.given, FamilyName: customer.person.family } : {}),
      ...(customer.email ? { PrimaryEmailAddr: { Address: customer.email } } : {}),
      ...(customer.phone ? { PrimaryPhone: { FreeFormNumber: customer.phone } } : {}),
    });
    counts.created += 1;
    console.log(`  + customer ${made.DisplayName} (Id ${made.Id})`);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// --deactivate-demo
// ---------------------------------------------------------------------------

/**
 * Flag Intuit's stock landscaping records inactive with sparse updates.
 *
 * Deactivation, not deletion, and not by choice: QuickBooks refuses to hard-delete a
 * name-list record that has transactions, and §23 Rule 3 says flag rather than delete
 * anyway. It is also fully reversible — one sparse update with `Active: true`.
 *
 * Targets come from the explicit (id, name) allow-list in src/qbo/demo-catalog.ts and
 * *both* must match. See the comment on STOCK_CUSTOMERS for why an allow-list rather than
 * `synced_at`-based detection.
 *
 * Refusals are collected, not thrown. QuickBooks treats `Active: false` on a name-list
 * record as a soft delete and rejects it outright when the record still has unbilled
 * billable charges (fault 6280) — a state some of Intuit's stock customers ship in. One
 * such customer must not strand the other twenty-eight still cluttering the picker.
 */
interface DeactivateResult {
  customers: number;
  items: number;
  skipped: number;
  refused: { entity: string; name: string; message: string }[];
}

/**
 * Undo QuickBooks' rename-on-deactivate, so an already-deactivated record still matches
 * the name in the allow-list. Exported shape is a plain string function so it is trivially
 * testable alongside the other catalog helpers.
 */
function stripDeletedSuffix(name: string): string {
  return name.replace(/ \(deleted\)$/, '');
}

async function deactivateStock(): Promise<DeactivateResult> {
  const customers = await queryAll('Customer', 'Active in (true, false)');
  const items = await queryAll('Item', 'Active in (true, false)');
  let skipped = 0;
  const refused: DeactivateResult['refused'] = [];

  const run = async (
    entity: 'Customer' | 'Item',
    live: any[],
    allowList: { id: string; name: string }[],
    nameOf: (record: any) => string
  ): Promise<number> => {
    const byId = new Map<string, any>(live.map((r) => [r.Id, r]));
    let count = 0;
    for (const target of allowList) {
      const record = byId.get(target.id);
      if (!record) {
        console.log(`  ? ${entity} ${target.id} (${target.name}) not found — skipped`);
        skipped += 1;
        continue;
      }
      // The name check is the safety belt: if ids ever shifted, a mismatch means we are
      // looking at some *other* record and must not touch it.
      //
      // The `(deleted)` strip is not cosmetic — QuickBooks *renames* a record it has
      // deactivated to "<Name> (deleted)", so comparing raw names would make a re-run
      // report all 47 targets as suspicious mismatches and skip them. Stripping the suffix
      // is what keeps --deactivate-demo a true no-op the second time.
      if (stripDeletedSuffix(nameOf(record)) !== target.name) {
        console.log(`  ! ${entity} ${target.id} is "${nameOf(record)}", expected "${target.name}" — skipped`);
        skipped += 1;
        continue;
      }
      if (record.Active === false) continue; // already inactive: re-run is a no-op
      try {
        await update(entity, { Id: record.Id, SyncToken: record.SyncToken, Active: false });
        console.log(`  - deactivated ${entity} ${target.name}`);
        count += 1;
      } catch (err) {
        const message = err instanceof QboError ? (err.fault?.detail ?? err.fault?.message ?? err.message) : String(err);
        console.log(`  ! ${entity} ${target.name} refused: ${message}`);
        refused.push({ entity, name: target.name, message });
      }
    }
    return count;
  };

  const deactivatedCustomers = await run('Customer', customers, STOCK_CUSTOMERS, (r) => r.DisplayName);
  const deactivatedItems = await run('Item', items, STOCK_ITEMS, (r) => r.Name);
  return { customers: deactivatedCustomers, items: deactivatedItems, skipped, refused };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

try {
  validateDataset();
  console.log(
    `Dataset validated: ${ALL_CATEGORIES.length} categories, ${DEMO_PARTS.length} parts, ` +
      `${DEMO_SERVICES.length} services, ${DEMO_CUSTOMERS.length} customers.`
  );

  // The environment half of the guard runs *before* the first HTTP call, so an operator
  // pointed at production is told that, rather than getting whatever error a production
  // endpoint happens to return for a sandbox token. Re-checked below as part of the whole
  // predicate — this is an early exit, not the decision.
  if (
    !checkWriteGuard({ environment: config.environment, companyName: 'probe', confirmed: true }).ok
  ) {
    die(WRITE_GUARD_MESSAGES['production-environment']);
  }

  // The rest of the guard, before any write. The company name is printed *first* so the
  // --yes the operator already passed is at least verifiable after the fact, and so an
  // operator running it interactively without --yes is told what they nearly wrote to.
  let company: any;
  try {
    company = await companyInfo();
  } catch (err) {
    console.error(err instanceof QboError ? err.message : String(err));
    die('Could not read the QuickBooks company — refusing to write. Check tokens with `npm run auth`.');
  }

  console.log('');
  console.log(`  QuickBooks environment: ${config.environment}`);
  console.log(`  QuickBooks company:     ${company?.CompanyName ?? '(unknown)'}`);
  console.log('');

  const guard = checkWriteGuard({
    environment: config.environment,
    companyName: company?.CompanyName,
    confirmed: flags.yes,
  });
  if (!guard.ok) die(WRITE_GUARD_MESSAGES[guard.reason]);

  if (flags.purgeInvoices || flags.purgeStockTxns) {
    const entities = flags.purgeStockTxns ? STOCK_DEMO_TRANSACTIONS : INVOICES_ONLY;
    console.log(`Purging transactions (${entities.join(', ')})…`);
    const purge = await purgeTransactions(entities);
    for (const [entity, n] of Object.entries(purge.byEntity)) {
      if (n.found > 0) console.log(`  ${entity}: deleted ${n.deleted}/${n.found}`);
    }
    console.log(
      `  total ${purge.deleted}/${purge.found}; cleared ${purge.batchesCleared} local batch(es), reset ${purge.submissionsReset} tab(s).`
    );
    for (const f of purge.failures) {
      console.log(`  ! ${f.entity} ${f.id} (${f.docNumber ?? 'no DocNumber'}): ${f.message}`);
    }
  }

  console.log('Categories…');
  const { ids: categoryIds, counts: categoryCounts } = await seedCategories();
  console.log('Parts…');
  const partCounts = await seedParts(categoryIds);
  console.log(`Services (${DEMO_SERVICE_CATEGORY}, manager-only)…`);
  const serviceCounts = await seedServices(categoryIds);
  const reparented = await reparentStockServices(categoryIds);
  console.log('Customers…');
  const customerCounts = await seedCustomers();

  let stock: DeactivateResult = { customers: 0, items: 0, skipped: 0, refused: [] };
  if (flags.deactivateDemo) {
    console.log('Deactivating Intuit stock demo records…');
    stock = await deactivateStock();
  }

  console.log('');
  console.log(`Categories: ${categoryCounts.created} created, ${categoryCounts.adopted} adopted.`);
  console.log(`Parts:      ${partCounts.created} created, ${partCounts.adopted} adopted.`);
  console.log(`Services:   ${serviceCounts.created} created, ${serviceCounts.adopted} adopted.`);
  console.log(
    `Stock svcs: ${reparented.moved} re-parented under ${DEMO_SERVICE_CATEGORY}, ` +
      `${reparented.already} already there, ${reparented.skipped} skipped, ${reparented.refused.length} refused.`
  );
  for (const r of reparented.refused) console.log(`              ! ${r}`);
  console.log(`Customers:  ${customerCounts.created} created, ${customerCounts.adopted} adopted.`);
  if (flags.deactivateDemo) {
    console.log(`Stock data: ${stock.customers} customers and ${stock.items} items deactivated, ${stock.skipped} skipped.`);
    if (stock.refused.length > 0) {
      console.log(
        `            ${stock.refused.length} record(s) QuickBooks refused to deactivate — they stay in the picker:`
      );
      for (const r of stock.refused) console.log(`              ${r.entity} "${r.name}": ${r.message}`);
    }
  }
  console.log('');
  console.log('Run `npm run sync` to pull all of this into the app database.');
} catch (err) {
  if (!(err instanceof ExitError)) throw err;
} finally {
  await pool.end();
}
