// Who may see which items (design doc §8 least privilege, §9/§18.1 master data).
//
// Two audiences read the same `items` mirror and must NOT see the same rows:
//
//  - **Workers** record physical parts they fitted to a kart. Nothing else belongs on a
//    phone in a paddock: a worker cannot know how many days of mechanic time to bill, and
//    an accidental tap on "Team Support" is a $450 line on a customer's invoice.
//  - **Managers** review a customer before the money moves (§17) and are the only people
//    who may add a service line.
//
// The discriminator is a **QuickBooks category** (`items.category`, synced from
// `Item.ParentRef.name`). Mike classifies items in QuickBooks and the app reads the answer,
// so QuickBooks stays the single source of truth for what a thing *is* (§3, §23 Rule 2) and
// no schema change or app-side classification table is needed. Adding a future 'Labor'
// category is one entry in the list below.
//
// The rule lives here, once, as SQL fragments rather than being re-typed at each of the four
// call sites. Four hand-copied `WHERE` clauses is exactly how the worker read gets fixed and
// the worker *write* keeps letting a guessed item id through.

/**
 * QuickBooks categories whose items are manager-only.
 *
 * `Race Services` and not `Services`: QuickBooks enforces a unique `Name` across every Item
 * regardless of `Type`, and Intuit's stock demo ships an item literally named `Services`
 * (Id 1) which QuickBooks structurally refuses to delete or rename — it is the company's
 * default sales product. A create of a Category named `Services` comes back as fault 6000
 * ("You can't use Services because Services already exists"), verified against the sandbox.
 * `Race Services` is also the clearer name on an invoice, so it would be the choice anyway.
 */
export const MANAGER_ONLY_CATEGORIES = ['Race Services'] as const;

export type ManagerOnlyCategory = (typeof MANAGER_ONLY_CATEGORIES)[number];

/**
 * The item types the app can put on an invoice line. `Category` rows are excluded because
 * they are folders, not sellable things; §28 n.27 is why `Inventory` is tolerated but not
 * produced.
 */
const SELLABLE_TYPES = ['NonInventory', 'Service', 'Inventory'] as const;

/** Quote a fixed, code-owned string list for inlining into SQL. */
function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
}

const MANAGER_ONLY_CATEGORIES_SQL = sqlList(MANAGER_ONLY_CATEGORIES);

/**
 * Qualify a column for the caller's query. `items` is joined under an alias in some places
 * (the popular-parts aggregate) and queried bare in others, so every fragment below takes
 * the alias rather than callers string-patching the SQL they were handed.
 */
function col(alias: string | undefined, name: string): string {
  return alias ? `${alias}.${name}` : name;
}

/**
 * Items a worker may see and record (design doc §8).
 *
 * The `sku IS NOT NULL` clause is belt-and-braces, and deliberate. Every real racing part
 * carries a SKU — it is the permanent technical identifier (§9/§10) and the demo seeder
 * refuses to create a part without one — so requiring it costs nothing. What it buys is that
 * Intuit's two undeletable stock service items, `Services` (Id 1) and `Hours` (Id 2), stay
 * off workers' phones **even if** the seeder's attempt to re-parent them under
 * `Race Services` fails: they have no SKU and never will. One unclassified row in
 * QuickBooks then means "hidden from workers", which is the safe default for a screen whose
 * every tap is a charge.
 *
 * Inlined literals, not bind parameters: the values come from the constant above, never from
 * a request, and a fragment with no placeholders composes into any caller's query without
 * having to renumber their `$n`.
 */
export function workerVisibleItemSql(alias?: string): string {
  return `${col(alias, 'active')}
    AND ${col(alias, 'type')} IN (${sqlList(SELLABLE_TYPES)})
    AND ${col(alias, 'sku')} IS NOT NULL
    AND (${col(alias, 'category')} IS NULL
         OR ${col(alias, 'category')} NOT IN (${MANAGER_ONLY_CATEGORIES_SQL}))`;
}

/** Service items only: what a manager may add and a worker may not (design doc §17). */
export function managerOnlyItemSql(alias?: string): string {
  return `${col(alias, 'active')}
    AND ${col(alias, 'type')} IN (${sqlList(SELLABLE_TYPES)})
    AND ${col(alias, 'category')} IN (${MANAGER_ONLY_CATEGORIES_SQL})`;
}

/**
 * Everything a manager may put on an invoice: parts **plus** services.
 *
 * Written as the union of the two fragments above rather than as its own predicate, so it is
 * true by construction that the manager sees a superset of the worker's catalogue and that
 * the three rules can never drift apart.
 */
export function managerSellableItemSql(alias?: string): string {
  return `((${workerVisibleItemSql(alias)}) OR (${managerOnlyItemSql(alias)}))`;
}

/**
 * The same manager-only test for TypeScript, used to label and group service items in the
 * review UI. Takes the category rather than a whole row so it works both for a catalogue
 * option and for a recorded line whose category was looked up alongside it.
 */
export function isManagerOnlyCategory(category: string | null | undefined): boolean {
  return category != null && (MANAGER_ONLY_CATEGORIES as readonly string[]).includes(category);
}

/**
 * The worker-visibility test for TypeScript. Mirrors `WORKER_VISIBLE_ITEM_SQL` clause for
 * clause; kept in step by `src/catalog.test.ts`, which asserts the two agree on the same
 * table of cases.
 */
export function isWorkerVisibleItem(item: {
  active: boolean;
  sku: string | null;
  type: string | null;
  category: string | null;
}): boolean {
  return (
    item.active &&
    item.type != null &&
    (SELLABLE_TYPES as readonly string[]).includes(item.type) &&
    item.sku != null &&
    !isManagerOnlyCategory(item.category)
  );
}

/**
 * Services are billed by the **day**, parts by the unit (owner's decision, 09/06/2026).
 * A day is a whole unit, so `validateQty`'s integer rule holds for both and no fractional
 * quantity support is needed anywhere. This is the label, and only the label, that differs.
 */
export function qtyUnitLabel(isService: boolean): { singular: string; plural: string } {
  return isService ? { singular: 'day', plural: 'Days' } : { singular: 'unit', plural: 'Qty' };
}
