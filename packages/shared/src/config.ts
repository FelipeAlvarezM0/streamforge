import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_PORT: z.coerce.number().default(3000),
  METRICS_PATH: z.string().default('/metrics'),
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgres://streamforge:streamforge@localhost:5432/streamforge'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  RABBITMQ_URL: z.string().min(1).default('amqp://guest:guest@localhost:5672'),
  RABBITMQ_PREFETCH: z.coerce.number().default(200),
  OUTBOX_BATCH_SIZE: z.coerce.number().default(250),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().default(1000),
  OUTBOX_INFLIGHT_LEASE_SECONDS: z.coerce.number().default(120),
  OUTBOX_LOCK_OWNER: z.string().default('publisher'),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().default(60 * 60 * 24 * 7),
  IDEMPOTENCY_DB_RETENTION_DAYS: z.coerce.number().default(90),
  DEDUPE_STRATEGY: z.enum(['full', 'intent']).default('intent'),
  DEDUPE_INCLUDE_OCCURRED_AT: z
    .any()
    .optional()
    .transform((value) => parseBoolean(value, false)),
  TENANT_RATE_LIMIT_PER_MINUTE: z.coerce.number().default(6000),
  TENANT_ALLOWLIST: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ADMIN_TOKEN: z.string().default('streamforge-admin-change-me'),
  ADMIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().default(300),
  STREAM_MAX_BYTES: z.coerce.number().default(1024 * 1024 * 128),
  MAX_EVENT_BYTES: z.coerce.number().default(1024 * 256),
  REPLAY_MAX_LIMIT: z.coerce.number().default(5000),
  MAX_RETRY_ATTEMPTS: z.coerce.number().default(5),
  RETRY_BACKOFF_MS: z
    .string()
    .default('1000,5000,30000,120000,600000')
    .transform((value) => value.split(',').map((item) => Number(item.trim())).filter(Boolean)),
  FAIL_RATE_PAYMENT: z.coerce.number().min(0).max(1).default(0),
  CLUSTER_ENABLED: z
    .any()
    .optional()
    .transform((value) => parseBoolean(value, false)),
  CLUSTER_WORKERS: z.coerce.number().default(0),
  OTEL_SERVICE_NAMESPACE: z.string().default('streamforge'),
  OTEL_SERVICE_NAME: z.string().default('service'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export const env = envSchema.parse(process.env);
