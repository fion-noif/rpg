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
2. **Create the event** on `/admin`: a code (`^[A-Z0-9]{1,8}$`, e.g. `R8`) and a
   name. Its detail page is the setup screen.
3. **Pick the customers being billed** from the synced QuickBooks customers.
   A customer must participate before anyone can record parts against them.
4. **Add workers** — reuse a person from a past event or type a new name. Each
   gets a fresh magic link, **shown once in the UI**; only its SHA-256 hash is
   stored. Lost it? *Rotate link* issues a new one and kills the old. Assign each
   worker their customer(s).
5. **Workers record parts** on their phones: assigned customer(s) → search or
   popular parts → quantities. Writes queue in a local outbox and retry until the
   server confirms, so flaky track Wi-Fi doesn't lose entries. UI is
   English/Spanish (toggle, persisted per worker).
6. **Review per customer** (event → customer): lines aggregated across workers
   with submitter names, edit/remove a quantity, add a missing part, running
   total, and an audit trail. Manager edits are append-only — the worker's
   original line is voided and a new line is recorded under the manager's own
   name, never overwritten.
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
must exactly match QuickBooks display names), then `npm run seed -- myevent.json`.
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
- The database currently contains smoke-test data (event `R7`, customers
  `101–104`, items `201–204`). To wipe operational data before real use:
  `docker exec -i rpg-db-1 psql -U racing racing -c
  "TRUNCATE submissions, assignments, workers, staff, events, event_customers, charge_batch_lines, admin_actions, items, customers CASCADE;"`
  (leave `admins` alone unless you also want to re-bootstrap an owner)
  then re-run `npm run sync`.
