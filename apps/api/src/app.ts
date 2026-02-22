import Fastify from 'fastify';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ZodError, z } from 'zod';
import {
  MAIN_QUEUE,
  correlationIdOrNew,
  dbPool,
  env,
  ingestCounter,
  ingestLatencyMs,
  initRabbit,
  metricsRegistry,
  normalizeEvent,
  query,
  redis,
  withSpan,
} from '@streamforge/shared';
import { enqueueEvent, reserveDedupeOnly } from './ingestion.js';
import { getDlqReasons, getEventStatusById, replayByFilter, retryDlq, type ReplayMode } from './repository.js';
import { tenantRateLimit } from './rate-limit.js';
import { adminGuard, getHeaderValue, requireTenant } from './security.js';
import { createNdjsonParseTransform, createXmlParseTransform, type StreamCounters } from './streaming.js';

const replaySchema = z.object({
  tenantId: z.string().min(1),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  type: z.string().optional(),
  status: z.enum(['FAILED', 'DLQ', 'COMPLETED']).optional(),
  mode: z.enum(['reprocess', 'republish']).default('reprocess'),
  limit: z.coerce.number().int().min(1).max(env.REPLAY_MAX_LIMIT).default(1000),
});

const dlqReasonQuerySchema = z.object({
  tenantId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

const dlqRetrySchema = z.object({
  tenantId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(env.REPLAY_MAX_LIMIT).default(500),
});

const detectParser = (contentType: string | undefined, counters: StreamCounters): Transform => {
  const header = (contentType ?? '').toLowerCase();
  if (header.includes('xml')) {
    return createXmlParseTransform(counters);
  }
  return createNdjsonParseTransform(counters);
};

const ensureBodySize = (body: unknown): boolean => {
  const bytes = Buffer.byteLength(JSON.stringify(body ?? {}));
  return bytes <= env.MAX_EVENT_BYTES;
};

export const createApi = async () => {
  const rabbit = await initRabbit();

  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    bodyLimit: env.STREAM_MAX_BYTES,
    disableRequestLogging: true,
  });

  app.get('/health', async () => ({ status: 'ok', service: 'streamforge-api', timestamp: new Date().toISOString() }));

  app.get('/ready', async (request, reply) => {
    const correlationId = correlationIdOrNew(getHeaderValue(request.headers, 'x-correlation-id'));

    try {
      await query('SELECT 1');
      await redis.ping();
      await rabbit.channel.checkQueue(MAIN_QUEUE);

      reply.send({
        status: 'ready',
        correlationId,
        checks: {
          postgres: 'ok',
          redis: 'ok',
          rabbitmq: 'ok',
        },
      });
    } catch (error) {
      request.log.error({ error, correlationId }, 'Readiness failed');
      reply.code(503).send({
        status: 'not_ready',
        correlationId,
      });
    }
  });

  app.post('/v1/events', { preHandler: tenantRateLimit as any }, async (request, reply) => {
    const startedAt = process.hrtime.bigint();
    const tenantId = requireTenant(request, reply);
    if (!tenantId) {
      return;
    }

    if (!ensureBodySize(request.body)) {
      reply.code(413).send({ message: `Event body exceeds MAX_EVENT_BYTES=${env.MAX_EVENT_BYTES}` });
      return;
    }

    const correlationId = correlationIdOrNew(getHeaderValue(request.headers, 'x-correlation-id'));
    const idempotencyKey = getHeaderValue(request.headers, 'x-idempotency-key');

    try {
      const normalizedEvent = normalizeEvent(request.body as any, tenantId, correlationId);

      const result = await withSpan(
        'api.ingest.single',
        {
          correlationId,
          tenantId,
          eventId: normalizedEvent.eventId,
        },
        () => enqueueEvent(normalizedEvent, idempotencyKey),
      );

      if (result.duplicate) {
        ingestCounter.inc({ tenantId, source: 'api', status: 'duplicate' });
        reply.code(409).send({
          accepted: false,
          duplicate: true,
          duplicateLayer: result.duplicateLayer,
          correlationId,
        });
        return;
      }

      ingestCounter.inc({ tenantId, source: normalizedEvent.source, status: 'accepted' });
      reply.code(202).send({
        accepted: true,
        duplicate: false,
        eventPk: result.eventPk,
        eventId: normalizedEvent.eventId,
        hash: normalizedEvent.hash,
        partitionKey: normalizedEvent.partitionKey,
        correlationId,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        ingestCounter.inc({ tenantId, source: 'api', status: 'invalid' });
        reply.code(400).send({
          accepted: false,
          message: 'Invalid event payload',
          issues: error.issues,
          correlationId,
        });
        return;
      }

      request.log.error({ error, correlationId, tenantId }, 'Single ingest failed');
      reply.code(500).send({
        accepted: false,
        message: 'Ingest failed',
        correlationId,
      });
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      ingestLatencyMs.observe({ endpoint: '/v1/events' }, elapsedMs);
    }
  });

  app.post('/v1/ingest/stream', { preHandler: tenantRateLimit as any }, async (request, reply) => {
    const startedAt = process.hrtime.bigint();
    const tenantId = requireTenant(request, reply);
    if (!tenantId) {
      return;
    }

    const correlationId = correlationIdOrNew(getHeaderValue(request.headers, 'x-correlation-id'));

    const counters: StreamCounters = {
      accepted: 0,
      duplicate: 0,
      invalid: 0,
      failed: 0,
    };

    const parseTransform = detectParser(getHeaderValue(request.headers, 'content-type'), counters);
    let totalBytes = 0;

    const byteLimitTransform = new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (totalBytes > env.STREAM_MAX_BYTES) {
          callback(new Error(`Stream exceeded STREAM_MAX_BYTES=${env.STREAM_MAX_BYTES}`));
          return;
        }
        callback(null, chunk);
      },
      highWaterMark: 16,
    });

    const dedupeTransform = new Transform({
      objectMode: true,
      highWaterMark: 32,
      transform: async function (chunk: Record<string, unknown>, _encoding, callback) {
        try {
          const rowCorrelationId =
            typeof chunk.correlationId === 'string' && chunk.correlationId.trim()
              ? (chunk.correlationId as string)
              : correlationId;

          const normalized = normalizeEvent(chunk as any, tenantId, rowCorrelationId);
          const dedupeResult = await reserveDedupeOnly(normalized);
          if (dedupeResult.duplicate) {
            counters.duplicate += 1;
            ingestCounter.inc({ tenantId, source: normalized.source, status: 'duplicate' });
            callback();
            return;
          }

          this.push({ normalized, reservation: dedupeResult.reservation });
          callback();
        } catch {
          counters.invalid += 1;
          callback();
        }
      },
    });

    const enrichTransform = new Transform({
      objectMode: true,
      highWaterMark: 32,
      transform: function (chunk, _encoding, callback) {
        this.push({
          ...chunk,
          ingestionTimestamp: new Date().toISOString(),
          streamCorrelationId: correlationId,
        });
        callback();
      },
    });

    const publishTransform = new Transform({
      objectMode: true,
      highWaterMark: 32,
      transform: async (chunk, _encoding, callback) => {
        const { normalized, reservation } = chunk as {
          normalized: ReturnType<typeof normalizeEvent>;
          reservation: { key: string; reserved: boolean } | undefined;
        };

        try {
          const result = await enqueueEvent(normalized, undefined, reservation);
          if (result.duplicate) {
            counters.duplicate += 1;
            ingestCounter.inc({ tenantId, source: normalized.source, status: 'duplicate' });
            callback();
            return;
          }

          counters.accepted += 1;
          ingestCounter.inc({ tenantId, source: normalized.source, status: 'accepted' });
          callback();
        } catch (error) {
          counters.failed += 1;
          callback(error as Error);
        }
      },
    });

    try {
      await withSpan('api.ingest.stream', { correlationId, tenantId }, async () => {
        await pipeline(request.raw, byteLimitTransform, parseTransform, dedupeTransform, enrichTransform, publishTransform);
      });

      reply.code(202).send({
        accepted: true,
        summary: counters,
        correlationId,
      });
    } catch (error) {
      request.log.error({ error, correlationId, tenantId, counters }, 'Stream ingest failed');
      reply.code(500).send({
        accepted: false,
        summary: counters,
        message: 'Stream ingest failed',
        correlationId,
      });
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      ingestLatencyMs.observe({ endpoint: '/v1/ingest/stream' }, elapsedMs);
    }
  });

  app.get('/v1/events/:id', async (request, reply) => {
    const correlationId = correlationIdOrNew(getHeaderValue(request.headers, 'x-correlation-id'));

    const client = await dbPool.connect();
    try {
      const result = await getEventStatusById(client, (request.params as { id: string }).id);
      if (!result) {
        reply.code(404).send({
          message: 'Event not found',
          correlationId,
        });
        return;
      }

      reply.send({
        ...result,
        correlationId,
      });
    } finally {
      client.release();
    }
  });

  app.post('/v1/admin/replay', { preHandler: adminGuard as any }, async (request, reply) => {
    const correlationId = correlationIdOrNew(getHeaderValue(request.headers, 'x-correlation-id'));

    try {
      const payload = replaySchema.parse(request.body as Record<string, unknown>);

      const count = await withSpan(
        'api.admin.replay',
        { correlationId, tenantId: payload.tenantId, mode: payload.mode },
        async () => {
          const client = await dbPool.connect();
          try {
            await client.query('BEGIN');
            const inserted = await replayByFilter(client, {
              ...payload,
              mode: payload.mode as ReplayMode,
            });
            await client.query('COMMIT');
            return inserted;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        },
      );

      reply.code(202).send({
        accepted: true,
        replayMode: payload.mode,
        replayed: count,
        correlationId,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        reply.code(400).send({
          accepted: false,
          message: 'Invalid replay filters',
          issues: error.issues,
          correlationId,
        });
        return;
      }

      request.log.error({ error, correlationId }, 'Replay failed');
      reply.code(500).send({
        accepted: false,
        message: 'Replay failed',
        correlationId,
      });
    }
  });

  app.get('/v1/admin/dlq/reasons', { preHandler: adminGuard as any }, async (request, reply) => {
    const correlationId = correlationIdOrNew(getHeaderValue(request.headers, 'x-correlation-id'));

    try {
      const queryParams = dlqReasonQuerySchema.parse(request.query as Record<string, unknown>);
      const client = await dbPool.connect();
      try {
        const reasons = await getDlqReasons(client, queryParams);
        reply.send({
          correlationId,
          reasons,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof ZodError) {
        reply.code(400).send({ message: 'Invalid query', issues: error.issues, correlationId });
        return;
      }
      request.log.error({ error, correlationId }, 'DLQ reasons failed');
      reply.code(500).send({ message: 'DLQ reasons failed', correlationId });
    }
  });

  app.post('/v1/admin/dlq/retry', { preHandler: adminGuard as any }, async (request, reply) => {
    const correlationId = correlationIdOrNew(getHeaderValue(request.headers, 'x-correlation-id'));

    try {
      const payload = dlqRetrySchema.parse(request.body as Record<string, unknown>);
      const client = await dbPool.connect();
      try {
        await client.query('BEGIN');
        const retried = await retryDlq(client, payload);
        await client.query('COMMIT');
        reply.code(202).send({
          accepted: true,
          retried,
          correlationId,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof ZodError) {
        reply.code(400).send({ message: 'Invalid retry payload', issues: error.issues, correlationId });
        return;
      }
      request.log.error({ error, correlationId }, 'DLQ retry failed');
      reply.code(500).send({ message: 'DLQ retry failed', correlationId });
    }
  });

  app.get(env.METRICS_PATH, async (_request, reply) => {
    const body = await metricsRegistry.metrics();
    reply.header('Content-Type', metricsRegistry.contentType);
    reply.send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ error }, 'Unhandled error');
    reply.code(500).send({ message: 'Unhandled error' });
  });

  const close = async (): Promise<void> => {
    await rabbit.channel.close();
    await rabbit.confirmChannel.close();
    await rabbit.connection.close();
  };

  return { app, close };
};
