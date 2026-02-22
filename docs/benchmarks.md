# Benchmarks

## Methodology

1. Start stack: `docker compose up --build`.
2. Run event benchmark: `npm run load:events`.
3. Run stream benchmark: `npm run load:stream`.
4. Collect generated JSON reports from `reports/`.

## Snapshot Table

The following numbers are taken from `reports/load-events-example.json` and `reports/load-stream-example.json`.

| Scenario | Concurrency | Duration | Avg Req/s | p50 Latency (ms) | p90 Latency (ms) | p99 Latency (ms) | Non-2xx |
|---|---:|---:|---:|---:|---:|---:|---:|
| `POST /v1/events` | 100 | 30s | 158.7 | 39 | 61 | 97 | 0 |
| `POST /v1/ingest/stream` | 20 | 20s | 24.5 | 121 | 188 | 329 | 0 |

## Notes

- Keep benchmark environment stable when comparing runs.
- Use same `MAX_EVENT_BYTES`, `STREAM_MAX_BYTES`, and worker count across runs.
- Save historical snapshots to track regressions.
