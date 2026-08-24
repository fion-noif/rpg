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
