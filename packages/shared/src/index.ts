import { env } from './config.js';
import { dbPool, query, transaction } from './db.js';
import { correlationIdOrNew, idempotencyKeyToHash } from './ids.js';
import {
  dedupeCounter,
  dlqCounter,
  dlqSizeGauge,
  ingestCounter,
  ingestLatencyMs,
  metricsRegistry,
  outboxBacklogGauge,
  processingLatencyMs,
  retryCounter,
  throughputGauge,
} from './metrics.js';
import { childLogger, logger } from './logger.js';
import { DLQ_QUEUE, EXCHANGE, MAIN_QUEUE, RETRY_QUEUE, initRabbit, parseMessage, publishConfirm } from './rabbit.js';
import { computeHash, incomingEventSchema, normalizeEvent, normalizedEventSchema, sortRecursively } from './schemas.js';
import { redis } from './redis.js';
import { tracer, withSpan } from './telemetry.js';

export type { IncomingEnvelope, IncomingEvent, NormalizedEvent } from './schemas.js';

export {
  env,
  logger,
  childLogger,
  tracer,
  withSpan,
  dbPool,
  query,
  transaction,
  redis,
  initRabbit,
  publishConfirm,
  parseMessage,
  EXCHANGE,
  MAIN_QUEUE,
  RETRY_QUEUE,
  DLQ_QUEUE,
  incomingEventSchema,
  normalizedEventSchema,
  normalizeEvent,
  computeHash,
  sortRecursively,
  correlationIdOrNew,
  idempotencyKeyToHash,
  ingestCounter,
  ingestLatencyMs,
  metricsRegistry,
  dedupeCounter,
  retryCounter,
  dlqCounter,
  dlqSizeGauge,
  processingLatencyMs,
  outboxBacklogGauge,
  throughputGauge,
};
