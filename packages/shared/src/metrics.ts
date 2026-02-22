import client from 'prom-client';

client.collectDefaultMetrics({ prefix: 'streamforge_' });

export const metricsRegistry = client.register;

export const ingestCounter = new client.Counter({
  name: 'streamforge_ingest_total',
  help: 'Total ingested events',
  labelNames: ['tenantId', 'source', 'status'],
});

export const ingestLatencyMs = new client.Histogram({
  name: 'streamforge_ingest_latency_ms',
  help: 'Ingest latency in milliseconds',
  buckets: [1, 5, 10, 50, 100, 250, 500, 1000, 2000],
  labelNames: ['endpoint'],
});

export const dedupeCounter = new client.Counter({
  name: 'streamforge_dedupe_hits_total',
  help: 'Total dedupe hits',
  labelNames: ['tenantId', 'layer'],
});

export const retryCounter = new client.Counter({
  name: 'streamforge_worker_retry_total',
  help: 'Total worker retries',
  labelNames: ['tenantId', 'type'],
});

export const dlqCounter = new client.Counter({
  name: 'streamforge_worker_dlq_total',
  help: 'Total messages sent to DLQ',
  labelNames: ['tenantId', 'type'],
});

export const dlqSizeGauge = new client.Gauge({
  name: 'streamforge_dlq_size',
  help: 'Current number of messages in DLQ',
});

export const processingLatencyMs = new client.Histogram({
  name: 'streamforge_worker_latency_ms',
  help: 'Worker processing latency in milliseconds',
  buckets: [1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000],
  labelNames: ['tenantId', 'type', 'status'],
});

export const outboxBacklogGauge = new client.Gauge({
  name: 'streamforge_outbox_backlog',
  help: 'Current outbox backlog',
});

export const throughputGauge = new client.Gauge({
  name: 'streamforge_events_per_second',
  help: 'Approximate throughput in events/sec',
});
