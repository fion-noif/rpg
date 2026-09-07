-- Racing parts app schema (M1). Applied idempotently by scripts/migrate.ts.

CREATE TABLE IF NOT EXISTS qbo_tokens (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  realm_id           TEXT NOT NULL,
  access_token       TEXT NOT NULL,
  refresh_token      TEXT NOT NULL,
  access_expires_at  BIGINT NOT NULL, -- epoch ms
  refresh_expires_at BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL
);

-- Synced from QuickBooks (read-only in the app; design doc §3).
CREATE TABLE IF NOT EXISTS customers (
  qbo_id       TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  active       BOOLEAN NOT NULL,
  sync_token   TEXT NOT NULL,
  raw          JSONB NOT NULL,
  synced_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  qbo_id      TEXT PRIMARY KEY,
  sku         TEXT,
  name        TEXT NOT NULL,
  description TEXT,
  unit_price  NUMERIC(12,2),
  type        TEXT,
  category    TEXT,
  active      BOOLEAN NOT NULL,
  sync_token  TEXT NOT NULL,
  raw         JSONB NOT NULL,
  synced_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  entity         TEXT PRIMARY KEY,
  last_synced_at TIMESTAMPTZ NOT NULL
);

-- App-owned operational data (design doc §3).
CREATE TABLE IF NOT EXISTS events (
  id        SERIAL PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workers (
  id         SERIAL PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  name       TEXT NOT NULL,
  language   TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assignments (
  id              SERIAL PRIMARY KEY,
  worker_id       INTEGER NOT NULL REFERENCES workers(id),
  customer_qbo_id TEXT NOT NULL REFERENCES customers(qbo_id),
  UNIQUE (worker_id, customer_qbo_id)
);

-- Append-only (design doc §31): corrections are new rows/status changes, never destructive.
-- id is the client-generated UUID → outbox retries are idempotent (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS submissions (
  id              UUID PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id),
  worker_id       INTEGER NOT NULL REFERENCES workers(id),
  customer_qbo_id TEXT NOT NULL REFERENCES customers(qbo_id),
  status          TEXT NOT NULL DEFAULT 'SUBMITTED'
                  CHECK (status IN ('SUBMITTED', 'APPROVED', 'POSTED_TO_QUICKBOOKS', 'POST_FAILED')),
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lines snapshot item name/price at submission time (design doc §16).
CREATE TABLE IF NOT EXISTS submission_lines (
  id            SERIAL PRIMARY KEY,
  submission_id UUID NOT NULL REFERENCES submissions(id),
  item_qbo_id   TEXT NOT NULL REFERENCES items(qbo_id),
  sku           TEXT,
  item_name     TEXT NOT NULL,
  unit_price    NUMERIC(12,2),
  qty           NUMERIC(10,2) NOT NULL CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS submissions_event_customer
  ON submissions (event_id, customer_qbo_id);

-- Idempotency anchor for QuickBooks posting (design doc §23 Rule 5); used from M2.
CREATE TABLE IF NOT EXISTS charge_batches (
  id              SERIAL PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id),
  customer_qbo_id TEXT NOT NULL REFERENCES customers(qbo_id),
  doc_number      TEXT NOT NULL UNIQUE,
  qbo_invoice_id  TEXT,
  qbo_sync_token  TEXT,
  status          TEXT NOT NULL DEFAULT 'APPROVED'
                  CHECK (status IN ('APPROVED', 'POSTED', 'POST_FAILED')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at       TIMESTAMPTZ
);

-- M1.1: the worker "cart" moved server-side. A submission is now a running tab
-- (one per event/worker/customer) instead of a one-shot batch; lines are voided
-- (never deleted) so corrections stay append-only (design doc §31).
ALTER TABLE submission_lines ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE submission_lines ADD COLUMN IF NOT EXISTS voided_by INTEGER REFERENCES workers(id);
ALTER TABLE submission_lines ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- One running tab per (event, worker, customer); reused across the whole event.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_tab
  ON submissions (event_id, worker_id, customer_qbo_id);

-- At most one live line per item within a tab; a voided line frees the slot for re-add.
CREATE UNIQUE INDEX IF NOT EXISTS submission_lines_live
  ON submission_lines (submission_id, item_qbo_id)
  WHERE voided_at IS NULL;

-- Join key for the export and popular-parts queries; was missing.
CREATE INDEX IF NOT EXISTS submission_lines_submission
  ON submission_lines (submission_id);

-- ---------------------------------------------------------------------------
-- M2: admin app foundation (design doc §17 review, §21 weekend participation,
-- §22 ownership, §23 Rules 1/4/5). All statements below are replay-safe.
-- ---------------------------------------------------------------------------

-- Stable person identity, separate from per-event participation. `workers` remains
-- "one person's participation + credential for one event"; `staff` is what the admin's
-- worker picker selects from and where the sticky language default lives (§22: worker
-- and worker language are racing-app-owned).
-- Names are deliberately NOT unique: §23 Rule 1 forbids identity-by-name, so two real
-- people may legitimately share a display name and are told apart only by id.
CREATE TABLE IF NOT EXISTS staff (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  language   TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE workers ADD COLUMN IF NOT EXISTS staff_id INTEGER REFERENCES staff(id);

-- One-time backfill of pre-M2 worker rows, which have no staff identity at all. Name is
-- the only signal available for this dead data, so it is used exactly once, here; from
-- this point on all matching is by staff_id (§23 Rule 1). Both statements are guarded on
-- `staff_id IS NULL`, so after the SET NOT NULL below they can never match a row again
-- and every replay is a no-op.
INSERT INTO staff (name, language)
SELECT DISTINCT ON (w.name) w.name, w.language
FROM workers w
WHERE w.staff_id IS NULL
ORDER BY w.name, w.id;

UPDATE workers w
SET staff_id = s.id
FROM staff s
WHERE w.staff_id IS NULL AND s.name = w.name;

-- Loud failure if the backfill missed a row rather than a silently half-migrated table.
ALTER TABLE workers ALTER COLUMN staff_id SET NOT NULL;

-- A person participates in an event at most once. Fails loudly if a pre-M2 event already
-- has two same-named workers (they collapsed onto one staff row above); pre-check with
--   SELECT event_id, name FROM workers GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS workers_event_staff ON workers (event_id, staff_id);

-- Token lifecycle. Closing an event must *destroy* worker credentials, not merely stop
-- honouring them (§8 least privilege), so the hash column becomes nullable — the UNIQUE
-- index permits many NULLs — and revocation is recorded alongside.
ALTER TABLE workers ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS token_revoked_at TIMESTAMPTZ;

-- "Revoked" means deleted, not flagged: a revoked row can never still carry a usable hash.
DO $$
BEGIN
  ALTER TABLE workers ADD CONSTRAINT workers_revoked_has_no_hash
    CHECK (token_revoked_at IS NULL OR token_hash IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Event close is a distinct admin action: stamps closed_at, clears active, and revokes
-- every worker token for the event in one transaction.
ALTER TABLE events ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- The manager is modelled as one synthetic worker per event (token_hash NULL, its own
-- staff row), created lazily by the admin code. Manager-authored and manager-voided lines
-- therefore keep submissions.worker_id NOT NULL and leave every existing query and type
-- unchanged; readers label those rows "Manager" off this flag.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Weekend customer participation (§21, §22): a customer is added to the event before any
-- worker is assigned or any usage recorded. Also the lock row that serialises a worker's
-- write against the manager's approval of the same customer.
CREATE TABLE IF NOT EXISTS event_customers (
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  customer_qbo_id TEXT NOT NULL REFERENCES customers(qbo_id),
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, customer_qbo_id)
);

-- Backfill participation for pre-M2 events from what implies it: assignments and any tab
-- already opened. ON CONFLICT DO NOTHING makes replay a no-op.
INSERT INTO event_customers (event_id, customer_qbo_id)
SELECT w.event_id, a.customer_qbo_id
FROM assignments a JOIN workers w ON w.id = a.worker_id
UNION
SELECT s.event_id, s.customer_qbo_id FROM submissions s
ON CONFLICT DO NOTHING;

-- The approved aggregate is persisted, not recomputed (§23 Rule 4): the QBO invoice is
-- bookkeeper-mutable and worker tabs keep moving, so posting reads only these lines.
CREATE TABLE IF NOT EXISTS charge_batch_lines (
  id          SERIAL PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES charge_batches(id) ON DELETE CASCADE,
  item_qbo_id TEXT NOT NULL REFERENCES items(qbo_id),
  sku         TEXT,
  item_name   TEXT NOT NULL,
  unit_price  NUMERIC(12,2),
  qty         NUMERIC(10,2) NOT NULL CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS charge_batch_lines_batch
  ON charge_batch_lines (batch_id);

-- One invoice per customer per event (§23 Rule 5). This index is what makes the approve
-- claim (INSERT ... ON CONFLICT DO NOTHING) the single winner of a double-approve race.
CREATE UNIQUE INDEX IF NOT EXISTS charge_batches_event_customer
  ON charge_batches (event_id, customer_qbo_id);

-- Posting attempt bookkeeping: distinguishes "never tried" (safe to un-approve) from
-- "unknown outcome" (must retry, which re-queries by DocNumber and adopts).
ALTER TABLE charge_batches ADD COLUMN IF NOT EXISTS post_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE charge_batches ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
ALTER TABLE charge_batches ADD COLUMN IF NOT EXISTS post_error TEXT;
-- Invoice created but QBO assigned its own DocNumber (custom transaction numbers raced
-- off): the id is still stored so it is never orphaned, but idempotency is unverifiable.
ALTER TABLE charge_batches ADD COLUMN IF NOT EXISTS doc_number_mismatch BOOLEAN NOT NULL DEFAULT FALSE;

-- Which batch a tab was folded into, so a posted submission points at its invoice.
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS charge_batch_id INTEGER REFERENCES charge_batches(id);

-- §17 "edits logged" / §23 Rule 4: append-only record of everything the manager did.
CREATE TABLE IF NOT EXISTS admin_actions (
  id              SERIAL PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  action          TEXT NOT NULL, -- edit-qty|void-line|add-line|approve|post|post-failed|unapprove|close-event
                                 -- |add-customer|remove-customer|add-worker|rotate-token
                                 -- |remove-worker|edit-event-dates
                                 -- |assign-customer|unassign-customer
  event_id        INTEGER REFERENCES events(id),
  customer_qbo_id TEXT REFERENCES customers(qbo_id),
  batch_id        INTEGER REFERENCES charge_batches(id) ON DELETE SET NULL,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The event code flows into a 21-character QBO DocNumber (RW-{code}-{customerId}) and into
-- a QBO query literal, so its shape is constrained at the source rather than escaped at
-- every use site.
DO $$
BEGIN
  ALTER TABLE events ADD CONSTRAINT events_code_format CHECK (code ~ '^[A-Z0-9]{1,8}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- M3: named admin accounts (§23 Rule 4 — an audit row has to name a person, not
-- a role). The single shared admin password could only ever say "a manager did
-- this"; Mike hires managers, so every one of them signs in as themselves and
-- every adjustment, approval and post carries their name. All statements below
-- are replay-safe.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  -- The login handle. Unique, unlike staff.name (§23 Rule 1 forbids identity-by-name
  -- for *people*; a credential handle is not an identity, it is a lookup key).
  username      TEXT NOT NULL UNIQUE,
  -- The real name, and the single source of truth for it: the admin's staff row and
  -- per-event worker rows are updated from here, never edited independently.
  name          TEXT NOT NULL,
  -- `scrypt$<saltHex>$<hashHex>` (src/admin-password.ts). The scheme and salt travel
  -- with the digest so the parameters can be raised later without a flag day.
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'manager')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  -- The revocation lever, and the reason there is still no session table: the cookie
  -- carries the version it was minted with, so bumping this invalidates one admin's
  -- outstanding sessions immediately. Password change and deactivation both bump it.
  -- (Rotating ADMIN_SECRET still invalidates *everyone's*, as before.)
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each admin gets exactly one staff row carrying their real name. That is the whole
-- attribution mechanism: a manager adjustment is still a line on a synthetic
-- `workers.is_admin` row, so the worker screens, the review page and the CSV export
-- keep working unchanged — they just read a real name now instead of 'Manager'.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS admin_id INTEGER REFERENCES admins(id);

-- Partial, because staff rows for real workers have no admin_id and there are many of them.
CREATE UNIQUE INDEX IF NOT EXISTS staff_admin ON staff (admin_id) WHERE admin_id IS NOT NULL;

-- §23 Rule 4 (audit: who). Nullable on purpose and left that way: pre-M3 rows were
-- written by the anonymous shared password and script-triggered actions have no person
-- behind them at all. History is not rewritten — an unknown actor stays unknown rather
-- than being back-attributed to whoever happens to be the owner today.
ALTER TABLE admin_actions ADD COLUMN IF NOT EXISTS admin_id INTEGER REFERENCES admins(id);

CREATE INDEX IF NOT EXISTS admin_actions_admin ON admin_actions (admin_id, id DESC);

-- ---------------------------------------------------------------------------
-- M4: event dates, generated event codes, and expiring worker links.
--
-- A race weekend is a date range, and the manager knows those dates — so they are now the
-- input, and `events.code` is derived from them instead of typed. The code stays in the
-- schema because it is not a label: it is the QuickBooks DocNumber (`RW-{code}-{customerId}`,
-- src/charges.ts) that makes posting idempotent under §23 Rule 5, and the bookkeeper
-- reconciles against it inside QuickBooks. It is therefore write-once — by the time anyone
-- edits an event's dates the code may already be printed on a posted invoice, so it is
-- never re-derived (src/admin/events.ts `updateEventDates`).
--
-- The dates also give worker links a lifetime for the first time: expiry is *derived* from
-- `end_date` on every request (src/workers.ts `resolveToken`) rather than stamped onto each
-- token, so extending a weekend that ran long extends every worker's link at once and no
-- credential can disagree with the event it belongs to.
-- All statements below are replay-safe.
-- ---------------------------------------------------------------------------

ALTER TABLE events ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS end_date   DATE;

-- One-time backfill of pre-M4 events, which have no dates at all. `created_at` is the only
-- signal available, and a weekend is three days; both columns are guarded on IS NULL so
-- this can never touch a row that has real dates, and every replay is a no-op.
UPDATE events
SET start_date = COALESCE(start_date, created_at::date),
    end_date   = COALESCE(end_date, created_at::date + 2)
WHERE start_date IS NULL OR end_date IS NULL;

-- Loud failure if the backfill missed a row rather than a silently half-migrated table.
-- (SET NOT NULL on an already-NOT NULL column is a no-op, so this replays cleanly.)
ALTER TABLE events ALTER COLUMN start_date SET NOT NULL;
ALTER TABLE events ALTER COLUMN end_date   SET NOT NULL;

-- A single-day event is legal (end = start); an event that ends before it starts is not,
-- and would hand `resolveToken` an already-expired link for a weekend still to come.
DO $$
BEGIN
  ALTER TABLE events ADD CONSTRAINT events_dates_ordered CHECK (end_date >= start_date);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
