import { setTimeout as sleep } from 'node:timers/promises';
import {
  MAIN_QUEUE,
  dbPool,
  env,
  initRabbit,
  logger,
  outboxBacklogGauge,
  publishConfirm,
  query,
  throughputGauge,
  withSpan,
} from '@streamforge/shared';
import { nextOutboxStatusOnPublish } from './state.js';

type OutboxRow = {
  id: number;
  tenant_id: string;
  payload: Record<string, unknown>;
};

const LOCK_OWNER = `${env.OUTBOX_LOCK_OWNER}-${process.pid}`;

const claimOutboxBatch = async (batchSize: number): Promise<OutboxRow[]> => {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<OutboxRow>(
      `WITH selected AS (
        SELECT id
        FROM outbox
        WHERE (
          status IN ('PENDING', 'FAILED')
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        )
        OR (
          status = 'IN_FLIGHT'
          AND lock_acquired_at IS NOT NULL
          AND lock_acquired_at <= NOW() - make_interval(secs => $2::int)
        )
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox o
      SET
        status = 'IN_FLIGHT',
        lock_owner = $3,
        lock_acquired_at = NOW()
      FROM selected
      WHERE o.id = selected.id
      RETURNING o.id, o.tenant_id, o.payload`,
      [batchSize, env.OUTBOX_INFLIGHT_LEASE_SECONDS, LOCK_OWNER],
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const markPublished = async (id: number): Promise<void> => {
  const status = nextOutboxStatusOnPublish('IN_FLIGHT', true);
  await query(
    `UPDATE outbox
     SET
       status = $2,
       published_at = NOW(),
       last_error = NULL,
       lock_owner = NULL,
       lock_acquired_at = NULL
     WHERE id = $1`,
    [id, status],
  );
};

const markFailed = async (id: number, message: string): Promise<void> => {
  const status = nextOutboxStatusOnPublish('IN_FLIGHT', false);
  await query(
    `UPDATE outbox
     SET
       status = $2,
       attempts = attempts + 1,
       last_error = $3,
       next_attempt_at = NOW() + INTERVAL '5 seconds',
       lock_owner = NULL,
       lock_acquired_at = NULL
     WHERE id = $1`,
    [id, status, message.slice(0, 4000)],
  );
};

const updateBacklogMetric = async (): Promise<void> => {
  const result = await query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
     FROM outbox
     WHERE status IN ('PENDING', 'FAILED', 'IN_FLIGHT')`,
  );
  const firstRow = result.rows[0];
  outboxBacklogGauge.set(Number(firstRow?.total ?? 0));
};

const main = async (): Promise<void> => {
  const rabbit = await initRabbit();
  let running = true;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'Publisher shutdown started');
    running = false;
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info({ lockOwner: LOCK_OWNER }, 'Publisher started');

  while (running) {
    const loopStart = Date.now();

    try {
      const batch = await withSpan('publisher.claim.batch', { batchSize: env.OUTBOX_BATCH_SIZE }, () =>
        claimOutboxBatch(env.OUTBOX_BATCH_SIZE),
      );

      for (const row of batch) {
        try {
          await withSpan('publisher.publish', { outboxId: row.id, tenantId: row.tenant_id }, async () => {
            await publishConfirm(rabbit.confirmChannel, MAIN_QUEUE, row.payload, {
              headers: {
                correlationId: row.payload.correlationId,
                tenantId: row.payload.tenantId,
                outboxId: row.id,
                partitionKey: row.payload.partitionKey,
              },
            });
          });
          await markPublished(row.id);
        } catch (error) {
          await markFailed(row.id, (error as Error).message);
          logger.error({ error, outboxId: row.id }, 'Outbox publish failed');
        }
      }

      const elapsedSeconds = Math.max(1, (Date.now() - loopStart) / 1000);
      throughputGauge.set(batch.length / elapsedSeconds);
      await updateBacklogMetric();
    } catch (error) {
      logger.error({ error }, 'Outbox loop failure');
    }

    await sleep(env.OUTBOX_POLL_INTERVAL_MS);
  }

  logger.info('Publisher draining complete');
  await rabbit.channel.close();
  await rabbit.confirmChannel.close();
  await rabbit.connection.close();
  await dbPool.end();
  process.exit(0);
};

main().catch((error) => {
  logger.error({ error }, 'Publisher crashed');
  process.exitCode = 1;
});
