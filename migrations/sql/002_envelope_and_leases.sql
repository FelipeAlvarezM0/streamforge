ALTER TABLE events ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS partition_key TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS spec_version TEXT;

UPDATE events SET subject = 'unknown' WHERE subject IS NULL;
UPDATE events SET partition_key = subject WHERE partition_key IS NULL;
UPDATE events SET spec_version = '1.0' WHERE spec_version IS NULL;

ALTER TABLE events ALTER COLUMN subject SET NOT NULL;
ALTER TABLE events ALTER COLUMN partition_key SET NOT NULL;
ALTER TABLE events ALTER COLUMN spec_version SET NOT NULL;

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS lock_owner TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS lock_acquired_at TIMESTAMPTZ;
UPDATE outbox SET status = 'IN_FLIGHT' WHERE status = 'PUBLISHING';

ALTER TABLE processing_attempts ADD COLUMN IF NOT EXISTS reason_code TEXT;

CREATE INDEX IF NOT EXISTS idx_events_partition_key ON events (tenant_id, partition_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox (status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_inflight_lease ON outbox (status, lock_acquired_at);
CREATE INDEX IF NOT EXISTS idx_processing_attempts_reason ON processing_attempts (reason_code, created_at DESC);
