# Racing Parts App

Mobile-friendly parts-usage entry for race weekends, with QuickBooks Online as
the master-data source and billing destination. Design: `docs/design.md`.

Status: **M0 (QuickBooks connectivity) done · M1 (worker entry prototype) built**.

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
```

Intuit app setup (client ID/secret, redirect URI, sandbox company, custom
transaction numbers) is described in `docs/design.md` §29–31 and the git
history of this README.

## Race weekend workflow (M1)

1. **Sync** master data: `npm run sync` (or
   `curl -X POST "$APP_BASE_URL/api/admin/sync?secret=$ADMIN_SECRET"`).
2. **Seed** the event, workers, and assignments: copy `seed.example.json`,
   edit (customer names must exactly match QuickBooks display names), then
   `npm run seed -- myevent.json`. It prints one magic login link per worker —
   send each worker their link. Re-running updates assignments and keeps
   existing links.
3. **Run the app**: `npm run dev` (or `npm run build && npm run start`).
   Workers open their link on their phone: assigned customer(s) → search or
   popular parts → quantities → Submit. Submissions queue in a local outbox
   and retry until the server confirms, so flaky track Wi-Fi doesn't lose
   entries. UI is English/Spanish (toggle, persisted per worker).
4. **Export** submitted usage as CSV (M1 escape hatch until M2's
   Approve & Post): `curl "$APP_BASE_URL/api/admin/export?secret=$ADMIN_SECRET"`.

## Manager (admin) access

Browsers sign in at **`/admin/login`** with `ADMIN_SECRET` as the password. That sets
a signed, httpOnly session cookie (`rw_admin`) good for 12 hours; from there
`/admin` and `/admin/usage` work without a secret in the URL. Sign out with the
button on `/admin`.

- Generate the secret with `openssl rand -base64 24` and put it in `.env`.
- **`?secret=` is for scripts only**, and only on `/api/admin/*` (`export`, `sync`).
  Admin *pages* ignore it — a secret in a page URL leaks into browser history,
  bookmarks, and `Referer` headers. An old bookmarked `/admin/login?secret=…`
  redeems itself for a cookie once, then you should drop the secret from the URL.
- **Rotating `ADMIN_SECRET` signs out every open session.** Sessions are stateless
  (nothing in the database), so changing the secret is the only revocation lever.
- If `ADMIN_SECRET` is unset, `/admin/login` says so and every admin endpoint
  returns 403 "not configured" rather than a 500.
- Failed logins are throttled to 10 per 10 minutes per client IP. That counter is
  per-process and best-effort — secret entropy is the real defense.

## QuickBooks utilities

```sh
npm run test-invoice   # M0 spike: create one idempotent draft invoice (run twice to verify)
```

## Notes

- Worker auth: admin-generated magic links (`/login/<token>`); only a SHA-256
  hash of the token is stored. Session cookie lasts 7 days.
- Admin auth: password → signed cookie, `src/admin-auth.ts`. There is no
  `middleware.ts` on purpose (per-route checks are the house style), so
  `src/admin-auth.test.ts` walks `app/admin/**` and `app/api/admin/**` and fails
  if any file forgets its guard.
- Submissions are append-only, keyed by a client-generated UUID — outbox
  retries are idempotent (`duplicate: true` on replay).
- The database currently contains smoke-test data (event `R7`, customers
  `101–104`, items `201–204`). To wipe operational data before real use:
  `docker exec -i rpg-expense-db-1 psql -U racing racing -c
  "TRUNCATE submission_lines, submissions, assignments, workers, charge_batches, events, items, customers CASCADE;"`
  then re-run `npm run sync` and `npm run seed`.
