# Failure Modes and Operations

## 1) RabbitMQ unavailable

Expected behavior:

- API keeps accepting valid events.
- Outbox backlog grows in PostgreSQL.
- Publisher marks rows as `FAILED` and retries later.

Operator checks:

- `/ready` should fail rabbit check.
- Metric: `streamforge_outbox_backlog` rising.
- Publisher logs show publish errors.

Recovery:

1. Restore RabbitMQ.
2. Verify publisher is running.
3. Confirm outbox backlog drains.

## 2) Redis unavailable

Expected behavior:

- Dedupe degrades to PostgreSQL idempotency barrier.
- Throughput may reduce due to higher DB contention.

Operator checks:

- API readiness redis check fails.
- dedupe continues via DB (no event loss).

## 3) Poison messages

Expected behavior:

- Non-retryable errors are routed directly to DLQ with `reason_code`.
- Retryable errors use `events.retry` until exhaustion.

Operator actions:

1. Inspect reasons: `GET /v1/admin/dlq/reasons`.
2. Apply fix (schema mapping, business rule, dependency).
3. Replay selected events: `POST /v1/admin/dlq/retry`.

## 4) Publisher crash mid-batch

Expected behavior:

- Claimed outbox rows remain `IN_FLIGHT`.
- Lease timeout allows another publisher instance to reclaim rows.

Operator checks:

- Monitor stale `IN_FLIGHT` records.
- Validate `OUTBOX_INFLIGHT_LEASE_SECONDS` against workload.
