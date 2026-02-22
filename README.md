# StreamForge

StreamForge is a high-throughput backend platform for real-time event ingestion and processing.
It accepts JSON, NDJSON, and XML streams, enforces idempotency, applies backpressure, publishes reliably through an outbox, and processes workloads with retries, DLQ, and auditability.

## Why StreamForge

Most ingestion systems break under one of these conditions: traffic spikes, duplicate delivery, broker outages, or replay operations.
StreamForge is designed to handle all four with deterministic behavior.

## Core Capabilities

- Multi-format ingestion: `POST /v1/events` and `POST /v1/ingest/stream` (NDJSON/XML)
- Native Node.js streaming pipeline with real backpressure (`pipeline` + `Transform`)
- Idempotency and deduplication in two layers (Redis + PostgreSQL)
- Transactional outbox (`events + outbox` in the same DB transaction)
- Reliable publisher with row leasing and stuck-job recovery
- Worker processing with retry classification and DLQ routing
- Full attempt audit trail with reason codes
- Admin replay and DLQ operational endpoints
- Structured logs, metrics, traces, and correlation IDs end-to-end

## Architecture

```text
HTTP Ingest (Fastify)
  -> Validate + Normalize + Dedupe
  -> PostgreSQL TX (events + idempotency_keys + outbox)
  -> Outbox Publisher
  -> RabbitMQ (events.main / events.retry / events.dlq)
  -> Worker (idempotent effects, retry, DLQ, audit)

Redis: dedupe hot path + tenant rate limiting
```

## Event Contract

Input envelope supports backward compatibility:

- `eventType` (preferred) or `type` (legacy)
- `subject` (preferred) or `entityId` (legacy)
- `schemaVersion`, `specVersion`, `occurredAt`, `source`, `payload`
- `partitionKey` (defaults to `subject`)

Internal normalized event:

- `eventId`, `tenantId`, `type`, `subject`, `partitionKey`
- `occurredAt`, `payload`, `source`
- `schemaVersion`, `specVersion`
- `hash`, `correlationId`

## Idempotency Semantics

Dedupe key selection:

1. If `X-Idempotency-Key` is present:
- hash(`tenantId + idempotencyKey`)

2. If no key is provided:
- `DEDUPE_STRATEGY=full`: use full event hash
- `DEDUPE_STRATEGY=intent` (default): hash business intent fields

Retention model:

- Redis TTL window: `IDEMPOTENCY_TTL_SECONDS`
- PostgreSQL retention: `IDEMPOTENCY_DB_RETENTION_DAYS`
- Cleanup script: `npm run prune:idempotency`

## Reliability Model

### Outbox state machine

`PENDING -> IN_FLIGHT -> PUBLISHED / FAILED`

Publisher behavior:

- `FOR UPDATE SKIP LOCKED`
- Per-row lease ownership (`lock_owner`, `lock_acquired_at`)
- Automatic recovery for stale `IN_FLIGHT` rows

### Worker retry model

- Retryable errors -> `events.retry` with exponential backoff
- Non-retryable errors -> direct `events.dlq`
- Retry exhaustion -> `events.dlq`

Every attempt is persisted in `processing_attempts` with:

- `status`
- `reason_code`
- `error_message`
- `duration_ms`

## API Surface

- `GET /health`
- `GET /ready`
- `POST /v1/events`
- `POST /v1/ingest/stream`
- `GET /v1/events/:id`
- `POST /v1/admin/replay`
- `GET /v1/admin/dlq/reasons`
- `POST /v1/admin/dlq/retry`
- `GET /metrics`

## Security and Multi-Tenancy

- `X-Tenant-Id` required for ingestion
- Optional tenant allowlist (`TENANT_ALLOWLIST`)
- Per-tenant rate limiting in Redis
- Admin endpoints protected by `X-Admin-Token`
- Separate admin rate limiting (`ADMIN_RATE_LIMIT_PER_MINUTE`)
- Payload size limits:
  - `MAX_EVENT_BYTES`
  - `STREAM_MAX_BYTES`

## Local Run

### Prerequisites

- Docker + Docker Compose
- Node.js 22+ (optional for local non-container runs)

### Start

```bash
cp .env.example .env
docker compose up --build
```

Scale workers:

```bash
docker compose up --build --scale worker=3
```

## Developer Commands

- `npm run build`
- `npm run lint`
- `npm run test`
- `npm run migrate`
- `npm run seed`
- `npm run prune:idempotency`
- `npm run load:events`
- `npm run load:stream`

## Observability

- Logs: structured with correlation and tenant context
- Traces: ingest -> outbox -> publish -> worker
- Metrics endpoint: `/metrics`
- Key metrics include ingest throughput, dedupe hits, retry counts, DLQ size, and outbox backlog

## Operational Endpoints (Admin)

Replay example:

```bash
curl -X POST http://localhost:3000/v1/admin/replay \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: <ADMIN_TOKEN>" \
  -d '{
    "tenantId":"tenant-a",
    "status":"DLQ",
    "mode":"reprocess",
    "limit":100
  }'
```

DLQ reasons example:

```bash
curl "http://localhost:3000/v1/admin/dlq/reasons?tenantId=tenant-a&limit=20" \
  -H "X-Admin-Token: <ADMIN_TOKEN>"
```

## Repository Layout

```text
apps/
  api/
  publisher/
  worker/
packages/
  shared/
migrations/
scripts/
tests/
infra/
```

## Validation Status (current workspace)

- Build: passing
- Lint: passing
- Unit tests: passing
- Integration tests: available (`RUN_INTEGRATION=1`)

## License

Proprietary until a license file is added.
