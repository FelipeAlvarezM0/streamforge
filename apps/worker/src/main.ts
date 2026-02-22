import { setTimeout as sleep } from 'node:timers/promises';
import type { ConsumeMessage } from 'amqplib';
import { z } from 'zod';
import {
  DLQ_QUEUE,
  MAIN_QUEUE,
  RETRY_QUEUE,
  dbPool,
  dlqCounter,
  dlqSizeGauge,
  env,
  initRabbit,
  logger,
  parseMessage,
  processingLatencyMs,
  publishConfirm,
  query,
  retryCounter,
  withSpan,
} from '@streamforge/shared';

const workerMessageSchema = z.object({
  eventPk: z.string().min(1),
  tenantId: z.string().min(1),
  eventId: z.string().min(1),
  type: z.string().min(1),
  subject: z.string().min(1),
  partitionKey: z.string().min(1),
  occurredAt: z.string().datetime(),
  payload: z.any(),
  source: z.string().min(1),
  schemaVersion: z.string().min(1),
  specVersion: z.string().optional(),
  hash: z.string().min(1),
  correlationId: z.string().min(1),
  replay: z.boolean().optional(),
  replayMode: z.string().optional(),
});

type WorkerEventMessage = z.infer<typeof workerMessageSchema>;

type ClassifiedError = {
  reasonCode: string;
  retryable: boolean;
  message: string;
};

class WorkerFailure extends Error {
  readonly reasonCode: string;
  readonly retryable: boolean;

  constructor(reasonCode: string, retryable: boolean, message: string) {
    super(message);
    this.reasonCode = reasonCode;
    this.retryable = retryable;
  }
}

const WORKER_NAME = process.env.WORKER_NAME ?? 'worker-default';

const shouldInjectFailure = (msg: WorkerEventMessage): boolean => {
  if (msg.type !== 'PAYMENT') {
    return false;
  }
  return Math.random() < env.FAIL_RATE_PAYMENT;
};

const classifyError = (error: unknown): ClassifiedError => {
  if (error instanceof WorkerFailure) {
    return {
      reasonCode: error.reasonCode,
      retryable: error.retryable,
      message: error.message,
    };
  }

  if (error instanceof z.ZodError) {
    return {
      reasonCode: 'INVALID_ENVELOPE',
      retryable: false,
      message: error.issues.map((item) => item.message).join('; '),
    };
  }

  return {
    reasonCode: 'TRANSIENT_ERROR',
    retryable: true,
    message: error instanceof Error ? error.message : 'Unknown worker error',
  };
};

const isEffectAlreadyApplied = async (tenantId: string, eventPk: string): Promise<boolean> => {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM worker_effects WHERE tenant_id = $1 AND event_pk = $2 AND worker = $3
    ) AS exists`,
    [tenantId, eventPk, WORKER_NAME],
  );
  return Boolean(result.rows[0]?.exists);
};

const persistAttempt = async (
  tenantId: string,
  eventPk: string,
  attempt: number,
  status: 'SUCCESS' | 'RETRY' | 'FAILED' | 'DLQ',
  durationMs: number,
  reasonCode: string,
  errorMessage?: string,
): Promise<void> => {
  await query(
    `INSERT INTO processing_attempts (
      tenant_id,
      event_pk,
      worker,
      attempt_number,
      status,
      reason_code,
      error_message,
      duration_ms
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantId, eventPk, WORKER_NAME, attempt, status, reasonCode, errorMessage ?? null, Math.trunc(durationMs)],
  );
};

const markEventStatus = async (
  eventPk: string,
  status: 'COMPLETED' | 'FAILED' | 'DLQ',
  lastError?: string,
): Promise<void> => {
  await query(
    `UPDATE events
     SET processing_status = $2,
         last_error = $3,
         processed_at = CASE WHEN $2 = 'COMPLETED' THEN NOW() ELSE processed_at END
     WHERE id = $1`,
    [eventPk, status, lastError ?? null],
  );
};

const validateBusinessRules = (msg: WorkerEventMessage): void => {
  if (!['SALE', 'INVOICE', 'PAYMENT', 'REFUND', 'SHIPMENT'].includes(msg.type)) {
    throw new WorkerFailure('UNSUPPORTED_EVENT_TYPE', false, `Unsupported event type: ${msg.type}`);
  }

  if (msg.type === 'PAYMENT') {
    const payload = msg.payload as Record<string, unknown>;
    if (typeof payload.amount !== 'number') {
      throw new WorkerFailure('INVALID_PAYMENT_PAYLOAD', false, 'PAYMENT requires numeric payload.amount');
    }
  }
};

const applyBusinessEffect = async (msg: WorkerEventMessage): Promise<void> => {
  validateBusinessRules(msg);

  if (shouldInjectFailure(msg)) {
    throw new WorkerFailure('INJECTED_FAILURE', true, 'Injected failure for PAYMENT via FAIL_RATE_PAYMENT');
  }

  await query(
    `INSERT INTO worker_effects (tenant_id, event_pk, worker, effect_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, event_pk, worker) DO NOTHING`,
    [msg.tenantId, msg.eventPk, WORKER_NAME, msg.hash],
  );
};

const delayForAttempt = (attempt: number): number => {
  const index = Math.min(Math.max(attempt - 1, 0), env.RETRY_BACKOFF_MS.length - 1);
  return env.RETRY_BACKOFF_MS[index] ?? env.RETRY_BACKOFF_MS[env.RETRY_BACKOFF_MS.length - 1] ?? 1000;
};

const processMessage = async (
  raw: ConsumeMessage,
  publishRetryOrDlq: (routingKey: string, payload: WorkerEventMessage, options?: Record<string, unknown>) => Promise<void>,
): Promise<void> => {
  const decoded = parseMessage<unknown>(raw);
  const msg = workerMessageSchema.parse(decoded);
  const attempt = Number(raw.properties.headers?.attempt ?? 1);
  const started = Date.now();

  await withSpan(
    'worker.process',
    {
      tenantId: msg.tenantId,
      correlationId: msg.correlationId,
      eventId: msg.eventId,
      attempt,
      partitionKey: msg.partitionKey,
    },
    async () => {
      if (await isEffectAlreadyApplied(msg.tenantId, msg.eventPk)) {
        const durationMs = Date.now() - started;
        await persistAttempt(msg.tenantId, msg.eventPk, attempt, 'SUCCESS', durationMs, 'IDEMPOTENT_SKIP');
        processingLatencyMs.observe({ tenantId: msg.tenantId, type: msg.type, status: 'SUCCESS' }, durationMs);
        await markEventStatus(msg.eventPk, 'COMPLETED');
        return;
      }

      try {
        await applyBusinessEffect(msg);
        const durationMs = Date.now() - started;
        await persistAttempt(msg.tenantId, msg.eventPk, attempt, 'SUCCESS', durationMs, 'PROCESSED');
        processingLatencyMs.observe({ tenantId: msg.tenantId, type: msg.type, status: 'SUCCESS' }, durationMs);
        await markEventStatus(msg.eventPk, 'COMPLETED');
      } catch (error) {
        const durationMs = Date.now() - started;
        const classified = classifyError(error);

        if (!classified.retryable) {
          dlqCounter.inc({ tenantId: msg.tenantId, type: msg.type });
          await persistAttempt(msg.tenantId, msg.eventPk, attempt, 'DLQ', durationMs, classified.reasonCode, classified.message);
          await markEventStatus(msg.eventPk, 'DLQ', classified.message);

          await publishRetryOrDlq(DLQ_QUEUE, msg, {
            headers: {
              attempt,
              tenantId: msg.tenantId,
              correlationId: msg.correlationId,
              reasonCode: classified.reasonCode,
              retryable: false,
              error: classified.message,
            },
          });
          return;
        }

        if (attempt < env.MAX_RETRY_ATTEMPTS) {
          retryCounter.inc({ tenantId: msg.tenantId, type: msg.type });
          await persistAttempt(msg.tenantId, msg.eventPk, attempt, 'RETRY', durationMs, classified.reasonCode, classified.message);
          await markEventStatus(msg.eventPk, 'FAILED', classified.message);

          const delay = delayForAttempt(attempt);
          await publishRetryOrDlq(RETRY_QUEUE, msg, {
            expiration: String(delay),
            headers: {
              attempt: attempt + 1,
              tenantId: msg.tenantId,
              correlationId: msg.correlationId,
              reasonCode: classified.reasonCode,
              retryable: true,
            },
          });
          return;
        }

        dlqCounter.inc({ tenantId: msg.tenantId, type: msg.type });
        await persistAttempt(msg.tenantId, msg.eventPk, attempt, 'DLQ', durationMs, 'RETRY_EXHAUSTED', classified.message);
        await markEventStatus(msg.eventPk, 'DLQ', classified.message);

        await publishRetryOrDlq(DLQ_QUEUE, msg, {
          headers: {
            attempt,
            tenantId: msg.tenantId,
            correlationId: msg.correlationId,
            reasonCode: 'RETRY_EXHAUSTED',
            retryable: false,
            error: classified.message,
          },
        });
      }
    },
  );
};

const main = async (): Promise<void> => {
  const rabbit = await initRabbit();
  await rabbit.channel.prefetch(env.RABBITMQ_PREFETCH);

  let shuttingDown = false;
  let inFlight = 0;

  let consumerTag = '';

  const publishRetryOrDlq = async (
    routingKey: string,
    payload: WorkerEventMessage,
    options?: Record<string, unknown>,
  ): Promise<void> => {
    await publishConfirm(rabbit.confirmChannel, routingKey, payload, options);
    if (routingKey === DLQ_QUEUE) {
      const queueState = await rabbit.channel.checkQueue(DLQ_QUEUE);
      dlqSizeGauge.set(queueState.messageCount);
    }
  };

  const onMessage = async (message: ConsumeMessage | null): Promise<void> => {
    if (!message) {
      return;
    }

    if (shuttingDown) {
      rabbit.channel.nack(message, false, true);
      return;
    }

    inFlight += 1;
    try {
      await processMessage(message, publishRetryOrDlq);
      rabbit.channel.ack(message);
    } catch (error) {
      const classified = classifyError(error);
      logger.error({ error, reasonCode: classified.reasonCode }, 'Worker failed to process message');
      rabbit.channel.nack(message, false, false);
    } finally {
      inFlight -= 1;
    }
  };

  const consumeResult = await rabbit.channel.consume(MAIN_QUEUE, (msg) => {
    void onMessage(msg);
  });
  consumerTag = consumeResult.consumerTag;

  logger.info({ worker: WORKER_NAME, prefetch: env.RABBITMQ_PREFETCH }, 'Worker started');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, 'Worker shutdown started');

    if (consumerTag) {
      await rabbit.channel.cancel(consumerTag);
    }

    const waitUntil = Date.now() + 30_000;
    while (inFlight > 0 && Date.now() < waitUntil) {
      await sleep(100);
    }

    await rabbit.channel.close();
    await rabbit.confirmChannel.close();
    await rabbit.connection.close();
    await dbPool.end();
    logger.info({ inFlight }, 'Worker shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

main().catch((error) => {
  logger.error({ error }, 'Worker crashed');
  process.exitCode = 1;
});
