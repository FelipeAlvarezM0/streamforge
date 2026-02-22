CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  source TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  spec_version TEXT NOT NULL DEFAULT '1.0',
  hash TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_events_tenant_event_id ON events (tenant_id, event_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant_occurred ON events (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_status ON events (processing_status);
CREATE INDEX IF NOT EXISTS idx_events_hash ON events (tenant_id, hash);
CREATE INDEX IF NOT EXISTS idx_events_partition_key ON events (tenant_id, partition_key, occurred_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, hash)
);

CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_pk UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  queue TEXT NOT NULL DEFAULT 'events.main',
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ,
  lock_owner TEXT,
  lock_acquired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_next_attempt ON outbox (status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_tenant ON outbox (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox (status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_inflight_lease ON outbox (status, lock_acquired_at);

CREATE TABLE IF NOT EXISTS processing_attempts (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_pk UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  worker TEXT NOT NULL,
  attempt_number INT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  error_message TEXT,
  duration_ms INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processing_attempts_event ON processing_attempts (event_pk, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_attempts_status ON processing_attempts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_attempts_reason ON processing_attempts (reason_code, created_at DESC);

CREATE TABLE IF NOT EXISTS worker_effects (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_pk UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  worker TEXT NOT NULL,
  effect_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, event_pk, worker)
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_updated_at ON events;
CREATE TRIGGER trg_events_updated_at
BEFORE UPDATE ON events
FOR EACH ROW
EXECUTE PROCEDURE set_updated_at();
