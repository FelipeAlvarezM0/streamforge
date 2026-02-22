# StreamForge

StreamForge is a production-oriented backend for real-time event ingestion and processing.
It is built for throughput, correctness, and operational safety under load, retries, replay, and partial outages.

## Product Highlights

- High-throughput ingestion: JSON, NDJSON, and XML stream support
- Native Node.js streaming backpressure (`pipeline` + `Transform`)
- Dual-layer idempotency/deduplication (Redis + PostgreSQL)
- Transactional outbox for broker reliability
- Worker retries with explicit error classification and DLQ routing
- Admin replay and DLQ operations
- Traceable execution via structured logs, metrics, and correlation IDs

## Architecture Snapshot

```text
Fastify API -> Postgres (events + idempotency + outbox)
           -> Redis (dedupe hot path + rate limit)
Outbox Publisher -> RabbitMQ (main/retry/dlq)
Worker Pool -> idempotent effects + audit trail
```

Extended documentation:

- `docs/architecture.md`
- `docs/sequences.md`
- `docs/failure-modes.md`
- `docs/benchmarks.md`

## Event Contract

Input envelope supports compatibility and evolution:

- `eventType` (preferred) or `type` (legacy)
- `subject` (preferred) or `entityId` (legacy)
- `schemaVersion`, `specVersion`, `occurredAt`, `source`, `payload`
- `partitionKey` (defaults to `subject`)

Internal normalized event includes:

- `eventId`, `tenantId`, `type`, `subject`, `partitionKey`
- `occurredAt`, `payload`, `source`, `schemaVersion`, `specVersion`
- `hash`, `correlationId`

## Idempotency and Dedupe Guarantees

Dedupe key logic:

1. If `X-Idempotency-Key` is present:
- hash(`tenantId + idempotencyKey`)

2. If `X-Idempotency-Key` is absent:
- `DEDUPE_STRATEGY=full`: full event hash
- `DEDUPE_STRATEGY=intent` (default): intent hash (business fields)

Persistence model:

- Redis TTL window: `IDEMPOTENCY_TTL_SECONDS`
- PostgreSQL strong barrier: `idempotency_keys (tenant_id, hash)`
- Retention maintenance: `npm run prune:idempotency`

## Reliability Model

Outbox state machine:

- `PENDING -> IN_FLIGHT -> PUBLISHED/FAILED`

Controls:

- `FOR UPDATE SKIP LOCKED`
- row lease ownership (`lock_owner`, `lock_acquired_at`)
- stale lease recovery (`OUTBOX_INFLIGHT_LEASE_SECONDS`)

Worker classification:

- retryable errors -> `events.retry`
- non-retryable errors -> direct `events.dlq`
- retry exhausted -> `events.dlq`

Every attempt is persisted with `status`, `reason_code`, `error_message`, and `duration_ms`.

## API Endpoints

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

- `X-Tenant-Id` required
- Optional tenant allowlist (`TENANT_ALLOWLIST`)
- Per-tenant rate limiting in Redis
- Admin token protection (`X-Admin-Token`)
- Admin rate limiting (`ADMIN_RATE_LIMIT_PER_MINUTE`)
- Payload controls: `MAX_EVENT_BYTES`, `STREAM_MAX_BYTES`

## Local Run

Requirements:

- Docker + Docker Compose
- Node.js 22+ (optional if running outside containers)

Start:

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
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:coverage`
- `npm run migrate`
- `npm run seed`
- `npm run prune:idempotency`
- `npm run load:events`
- `npm run load:stream`

## CI/CD

GitHub Actions workflow: `.github/workflows/ci.yml`

Pipeline stages:

- Quality: install, lint, build, unit tests, coverage artifact
- Integration: service containers (PostgreSQL, Redis, RabbitMQ), migrate, boot API/publisher/worker, run integration tests

## Benchmark Snapshot

Source: `reports/load-events-example.json`, `reports/load-stream-example.json` and summarized in `reports/benchmark-summary.md`.

| Scenario | Concurrency | Duration | Avg Req/s | p50(ms) | p90(ms) | p99(ms) |
|---|---:|---:|---:|---:|---:|---:|
| `POST /v1/events` | 100 | 30s | 158.7 | 39 | 61 | 97 |
| `POST /v1/ingest/stream` | 20 | 20s | 24.5 | 121 | 188 | 329 |

For methodology and reproducibility, see `docs/benchmarks.md`.

## Repository Structure

```text
apps/
  api/
  publisher/
  worker/
packages/
  shared/
migrations/
scripts/
reports/
docs/
.github/workflows/
```

## License

MIT. See `LICENSE`.
