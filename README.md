# Racing Parts App

Mobile-friendly parts-usage entry for race weekends, with QuickBooks Online as
the master-data source and billing destination. Design: `docs/design.md`.

Status: **M0 (QuickBooks connectivity), M1 (worker entry), M2 (admin review +
posting), M3 (named admin accounts) done** — the full loop from a worker's tap to
a draft invoice in QuickBooks runs in the browser, and every manager action
carries the name of the manager who took it. Next: the rest of M3 hardening
(design doc §30).

## Stack

Next.js (one app: worker UI + API) · PostgreSQL (Docker locally, RDS in prod) ·
direct QuickBooks REST calls. Sync is manual-only (design doc §19).

## Setup

```sh
cp .env.example .env   # fill in QBO_CLIENT_ID / QBO_CLIENT_SECRET / ADMIN_SECRET
npm install
npm run db:up          # start Postgres in Docker (port 5433)
npm run db:migrate     # apply db/schema.sql (idempotent)
npm run auth           # one-time QuickBooks OAuth (tokens now live in Postgres)
npm run sync           # pull Customers + Items from QuickBooks
npm run create-admin -- mrolison "Mike Rolison" --owner   # first admin account
```

Intuit app setup (client ID/secret, redirect URI, sandbox company) is described
in `docs/design.md` §29–31 and the git history of this README.

**Required QuickBooks setting:** turn on **Settings → Account and settings →
Sales → Custom transaction numbers**. Posting relies on a deterministic
DocNumber (`RW-<event>-<customerId>`) to be idempotent — with the setting off
QuickBooks silently substitutes its own number, query-before-create finds
nothing, and a retried post duplicates the invoice. The app pre-flights this
before creating anything and refuses the post with remediation text if it's off,
so a misconfigured company fails loudly rather than double-billing.

## Race weekend workflow

Everything below is a browser flow. Sign in at **`/admin/login`** with your own
username and password (see *Admin accounts*), then:

1. **Sync** master data — the *Sync from QuickBooks* button on `/admin` pulls
   Customers and Items. (`npm run sync` still works.)
2. **Create the event** on `/admin`: start and end dates plus a short description.
   Its detail page is the setup screen, where the dates can still be changed.
   The event *code* (`260904`) is generated from the start date — it exists to be
   the QuickBooks DocNumber (`RW-260904-58`) the bookkeeper reconciles against,
   not a label, so it is never typed and never changes once minted.
3. **Pick the customers being billed** from the synced QuickBooks customers.
   A customer must participate before anyone can record parts against them.
4. **Add workers** — reuse a person from a past event or type a new name. Each
   gets a fresh magic link, **shown once in the UI**; only its SHA-256 hash is
   stored. Lost it? *Rotate link* issues a new one and kills the old. Assign each
   worker their customer(s).

   Links stop working at the end of the day after the event's end date. If a
   weekend runs long, push the end date back on the event page — rotating a link
   will not help, because a new token derives the same expiry from the same event.
5. **Workers record parts** on their phones: assigned customer(s) → search or
   popular parts → quantities. Writes queue in a local outbox and retry until the
   server confirms, so flaky track Wi-Fi doesn't lose entries. UI is
   English/Spanish (toggle, persisted per worker).
6. **Review per customer** (event → customer): lines aggregated across workers
   with submitter names, edit/remove a quantity, add a missing part, running
   total, and an audit trail. Manager edits are append-only — the worker's
   original line is voided and a new line is recorded under the manager's own
   name, never overwritten.
   - **Add a service** here too — team support, mechanic, engine lease —
     billed in whole **days**, from a control kept separate from the parts
     picker because the units differ (design doc §9.2). Workers never see
     these items; only managers can add them. The running total shows a
     parts/services split, but the number that goes to QuickBooks is the one
     sum over every line.
7. **Approve & Post** → one idempotent draft Invoice per customer per event.
   Approving locks the customer: further worker writes are refused (409) and
   their app goes read-only with "this customer's parts have been approved".
   - A failed post shows the QuickBooks error verbatim with **Retry**. Retry
     re-queries by DocNumber and adopts an invoice that was in fact created, so
     it never duplicates.
   - **Un-approve** is allowed only while nothing has been posted
     (`post_attempts = 0`); it restores the tabs to editable. Once a post has
     been attempted you must retry to resolve the unknown state, and once
     `POSTED` the invoice belongs to QuickBooks — no un-approve (§23 Rule 2).
8. **Close the event** when every participating customer is posted (with an
   explicit override if not). This destroys every worker link for the event —
   their `/login/<token>` URLs stop working — and deactivates the event.

**CSV escape hatch** (still there, and the fallback if QuickBooks is down):
`curl "$APP_BASE_URL/api/admin/export?secret=$ADMIN_SECRET"`.

**CLI alternative to steps 2–4:** copy `seed.example.json`, edit (customer names
must exactly match QuickBooks display names; set `startDate`/`endDate` to the
weekend you are seeding, or the links it prints may already be expired), then
`npm run seed -- myevent.json`.
It prints one magic link per worker. Re-running updates assignments and keeps
existing links. `npm run rotate` re-issues a single worker's link.

## Admin accounts

Every manager has their own account. Their **real name** appears on every
adjustment, approval and invoice they touch, which is the point — an audit row
that says "a manager did this" answers nothing (§23 Rule 4).

**Bootstrap the first owner** (there is no UI for this — see *owner vs manager*):

```sh
npm run create-admin -- mrolison "Mike Rolison" --owner
```

It prints a generated password **once**; only its scrypt hash is stored. Sign in
at **`/admin/login`** with username + password and change it at `/admin/account`.

**Owner vs manager.** Two roles, no permission table:

| | owner | manager |
|---|---|---|
| Run a weekend (events, review, approve, post, close) | yes | yes |
| `/admin/admins` — create, deactivate, reset accounts | yes | no (403 → `/admin`) |
| `/admin/account` — change own password | yes | yes |

An owner can only be created from the CLI, deliberately: owners can deactivate
other owners, so it is not a one-click act. The last active owner cannot be
deactivated, and nobody can deactivate themselves.

**Temp passwords.** Creating a manager or resetting a password generates a
12-character password shown **once, in the response HTML** — never in a URL,
same rule as a worker magic link. Lost it? Reset again.

**Revocation** has two levers, and they are different sizes:

- **`token_version`** — per admin. The session cookie carries the version it was
  minted with, and every request re-checks it against the row, so a password
  change, a reset, or a deactivation signs that admin out on their *next click*.
  Changing your own password re-mints your own cookie, so you stay in while every
  other session on your account drops.
- **Rotating `ADMIN_SECRET`** — everyone, at once. It is the HMAC key, so every
  outstanding cookie becomes unverifiable. Still the blunt lever.

There is no session table; those two facts are what replaces it.

**`ADMIN_SECRET`'s three remaining jobs** (generate it with
`openssl rand -base64 24`):

1. HMAC key material for the `rw_admin` session cookie.
2. `?secret=` on the two **read-only script endpoints**, `/api/admin/export` and
   `/api/admin/sync`. Nothing else accepts it: a mutation needs a named actor, so
   every other admin route requires a cookie. Admin *pages* have never accepted
   it — a secret in a page URL leaks into history, bookmarks and `Referer`.
3. Nothing else. It is no longer a password, and `/admin/login?secret=…` no
   longer redeems itself for a cookie (that minted an *anonymous* session).

If `ADMIN_SECRET` is unset, `/admin/login` says so and every admin endpoint
returns 403 "not configured" rather than a 500 — nobody can hold a session
without it, correct password or not.

Failed logins are throttled to 10 per 10 minutes per client IP (not per
username: that would let anyone lock a named manager out of their own account).
The counter is per-process and best-effort; scrypt on the stored hash is the real
defense. A failed sign-in never says which half was wrong.

## QuickBooks utilities

```sh
npm run test-invoice   # M0 spike: create one idempotent draft invoice (run twice to verify)
```

## Demo data (sandbox only)

A fresh Intuit sandbox is the **stock landscaping demo company**, which undercuts
nearly every feature this app has: no SKUs on anything, no bilingual names, no
categories at all, and most items priced $0.00. Nothing in it exercises §10's
bilingual naming, §12.2's accent-tolerant search, or the manager's review screen.
These two scripts replace it with a believable karting dataset.

```sh
# 1. Catalog: 9 part categories, 95 priced bilingual parts with SKUs, one
#    manager-only `Race Services` category with 3 per-day services, 16 customers.
npm run seed-qbo -- --yes

# 2. Pull it into the app database.
npm run sync

# 3. A full race weekend: event, 8 workers with magic links, usage,
#    one customer POSTED and one POST_FAILED. Prints the link table.
npm run seed-demo
```

Optional flags on `npm run seed-qbo`:

| flag | what it does |
|---|---|
| `--yes` | **required.** Confirms the company name printed just above it. |
| `--deactivate-demo` | Flags Intuit's 29 stock customers and 18 stock items `Active: false`. |
| `--purge-invoices` | Deletes every invoice, so a tester's first invoice is their own. |
| `--purge-stock-txns` | Wider: deletes all of Intuit's stock transactions. Needed because QuickBooks refuses to deactivate a customer that still carries a balance or an unbilled charge. |

`npm run seed-demo -- --reset` rebuilds the demo weekend from scratch. It scrubs
only that event's rows — never `admins` (the owner account is the only way back
into the app) and never the synced `customers`/`items`, which are QuickBooks'
data, not ours (§3).

**The sandbox-only guard.** Both scripts refuse to write unless *all three* hold,
and each catches a different accident (`src/qbo/catalog.ts`, unit-tested):

1. `QBO_ENVIRONMENT` is exactly `sandbox`. Anything else — including a typo —
   fails closed. Checked before the first HTTP call.
2. `companyInfo()` returned a company name. If we cannot identify the target,
   "unknown" is not a safe default for a bulk write.
3. `--yes` was passed. `QBO_ENVIRONMENT` is one line in a file; a human is a
   second, independent signal. The company name is printed first, so the
   confirmation is informed rather than reflexive.

Everything else is idempotent: parts are matched by `Sku`, customers by
`DisplayName`, categories by `Name`. Re-running adopts what exists and creates
nothing. Every flag is a no-op the second time.

**Two things the seeder cannot fix.** QuickBooks structurally refuses to
deactivate the items `Services` and `Hours` (they are the company's default
product and default time-activity service) and any customer with a *billable*
charge it will not let go of. The script reports each one and why.

For the two items that is now harmless: the seeder **re-parents** them under
`Race Services` with a sparse update, which reclassifies them as manager-only
instead of leaving them as two unpriced taps in a worker's parts list. And even
if QuickBooks ever refuses *that*, neither has a SKU, and the worker-visibility
rule requires one — see below.

### Manager-only service items

The catalog carries three services, all billed **per race day** and all filed
under the `Race Services` category:

| SKU | Name | Rate |
|---|---|---|
| `SVC-TEAM-DAY` | Team Support (per day) - Apoyo de equipo (por día) | $450/day |
| `SVC-MECH-DAY` | Mechanic (per day) - Mecánico (por día) | $350/day |
| `SVC-ENGINE-DAY` | Engine Lease (per day) - Alquiler de motor (por día) | $300/day |

The category is what makes them manager-only — Mike classifies an item in
QuickBooks and the app reads the answer, so QuickBooks stays the source of truth
and a future `Labor` category is one line in `MANAGER_ONLY_CATEGORIES`
(`src/catalog.ts`). Not named `Services`, because QuickBooks enforces unique item
names across every type and the stock demo already holds that name.

That one rule lives in `src/catalog.ts` and is reused at every item call site —
the worker catalog, the popular strip, the worker *write* path, and the manager's
picker. Two properties worth knowing:

- **`sku IS NOT NULL` is deliberate belt-and-braces.** Every real part has a SKU,
  so requiring one costs nothing; what it buys is that an unclassified item
  defaults to *hidden from workers*, which is the safe default on a screen where
  every tap is a charge.
- **It is enforced on writes, not just in the picker.** Hiding a row from a
  dropdown is presentation, not authorisation. A worker who guesses a service
  item's QuickBooks id is refused in the transaction, as `unknown-item` — the same
  answer an unknown id gets, because confirming the id was real tells a prober
  something.

**Tax.** Prices quoted to customers already include tax; RPG remits separately.
The app never computes tax — `sum(qty × unit_price)` *is* the invoice total, items
are `Taxable: false`, and no `TxnTaxDetail`/`TaxCodeRef` is ever sent (design doc
§9.1). Turning QuickBooks sales tax on would break the §23 Rule 4 guarantee that
the approved amount equals the amount owed, so it is a design change, not a
settings flip.

**Parts are created `Taxable: false`, on purpose.** The app computes its running
total and `charge_batch_lines` as `sum(qty * unit_price)` and sends that as the
invoice `Amount`. QuickBooks applies sales tax *on top*, so a taxable part makes
the invoice `TotalAmt` disagree with the number the manager approved — and the
approved number is the amount of record (§23 Rule 4). **Tax is not covered by the
design doc at all.** Until it is, parts stay non-taxable so the two figures
reconcile exactly.

> **`APP_BASE_URL` must be reachable from a phone before real user testing.**
> Worker magic links are minted from `config.appBaseUrl` and baked into the link
> text. At the default `http://localhost:3000` every link resolves to the
> tester's *own* device and will not work from a phone in a paddock. Set it to
> the LAN IP or the deployed host **before** minting links to hand out — links
> already issued keep the old base and have to be rotated.

## Notes

- Worker auth: admin-generated magic links (`/login/<token>`); only a SHA-256
  hash of the token is stored. Session cookie lasts 7 days.
- Admin auth is two steps: `src/admin-auth.ts` verifies the cookie's signature
  and expiry (pure, unit-tested), then `src/admin-session.ts` loads the account
  and requires `active AND token_version = cookie.tokenVersion`. There is no
  `middleware.ts` on purpose (per-route checks are the house style), so
  `src/admin-auth.test.ts` walks `app/admin/**` and `app/api/admin/**` and fails
  if any file forgets its guard — or if a mutating route accepts `?secret=`.
- Admin adjustments are attributed by *data*, not by a new column: each admin
  owns one `staff` row (`staff.admin_id`) named after their account, and the
  per-event synthetic `workers.is_admin` row hangs off it. So the worker screens,
  the review page and the CSV export all read `workers.name` and get a real name
  with no query changes. Pre-M3 rows still read `Manager`, which is the honest
  answer for a line the shared password recorded — history is not rewritten.
- Usage is append-only (design doc §31): a write carries an *absolute* qty keyed
  on (customer, item), so replaying it from the outbox is idempotent with no
  per-operation id. Removing a part voids the line rather than deleting it.
- Approving a customer and posting their invoice serialise against worker writes
  through the `event_customers` row (`FOR SHARE` / `FOR UPDATE`), so a write can't
  slip in after the aggregate is snapshotted. The posted aggregate is stored in
  `charge_batch_lines` — QuickBooks invoices are bookkeeper-mutable, so amounts
  are never recomputed from usage after the fact (§23 Rule 4).
- The database currently contains smoke-test data (a Round 7 event, customers
  `101–104`, items `201–204`). To wipe operational data before real use:
  `docker exec -i rpg-db-1 psql -U racing racing -c
  "TRUNCATE submissions, assignments, workers, staff, events, event_customers, charge_batch_lines, admin_actions, items, customers CASCADE;"`
  (leave `admins` alone unless you also want to re-bootstrap an owner)
  then re-run `npm run sync`.
