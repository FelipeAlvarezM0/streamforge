import type { PoolClient } from 'pg';
import type { NormalizedEvent } from '@streamforge/shared';

export type PersistedEvent = {
  eventPk: string;
  outboxId: number;
};

export type ReplayMode = 'reprocess' | 'republish';

export const insertEventAndOutbox = async (
  client: PoolClient,
  event: NormalizedEvent,
): Promise<PersistedEvent> => {
  const eventInsert = await client.query<{ id: string }>(
    `INSERT INTO events (
      tenant_id,
      event_id,
      type,
      subject,
      partition_key,
      occurred_at,
      payload,
      source,
      schema_version,
      spec_version,
      hash,
      correlation_id,
      processing_status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RECEIVED')
    ON CONFLICT (tenant_id, event_id) DO NOTHING
    RETURNING id`,
    [
      event.tenantId,
      event.eventId,
      event.type,
      event.subject,
      event.partitionKey,
      event.occurredAt,
      event.payload,
      event.source,
      event.schemaVersion,
      event.specVersion,
      event.hash,
      event.correlationId,
    ],
  );

  if ((eventInsert.rowCount ?? 0) === 0) {
    const existing = await client.query<{ id: string }>('SELECT id FROM events WHERE tenant_id = $1 AND event_id = $2', [
      event.tenantId,
      event.eventId,
    ]);
    if ((existing.rowCount ?? 0) === 0) {
      throw new Error('Failed to fetch existing event after conflict');
    }
    const existingRow = existing.rows[0];
    if (!existingRow) {
      throw new Error('Missing existing event row');
    }
    return { eventPk: existingRow.id, outboxId: -1 };
  }

  const insertedEvent = eventInsert.rows[0];
  if (!insertedEvent) {
    throw new Error('Missing inserted event row');
  }
  const eventPk = insertedEvent.id;

  const outboxInsert = await client.query<{ id: number }>(
    `INSERT INTO outbox (tenant_id, event_pk, queue, payload, status)
     VALUES ($1, $2, 'events.main', $3, 'PENDING')
     RETURNING id`,
    [
      event.tenantId,
      eventPk,
      {
        eventPk,
        ...event,
      },
    ],
  );

  const outboxRow = outboxInsert.rows[0];
  if (!outboxRow) {
    throw new Error('Missing outbox row');
  }
  return { eventPk, outboxId: outboxRow.id };
};

export const getEventStatusById = async (client: PoolClient, id: string) => {
  const result = await client.query(
    `SELECT
      e.id,
      e.tenant_id,
      e.event_id,
      e.type,
      e.subject,
      e.partition_key,
      e.hash,
      e.correlation_id,
      e.processing_status,
      e.last_error,
      e.created_at,
      e.processed_at,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'attemptNumber', pa.attempt_number,
            'status', pa.status,
            'reasonCode', pa.reason_code,
            'errorMessage', pa.error_message,
            'durationMs', pa.duration_ms,
            'createdAt', pa.created_at
          ) ORDER BY pa.created_at DESC
        ) FILTER (WHERE pa.id IS NOT NULL),
        '[]'::json
      ) AS attempts
    FROM events e
    LEFT JOIN processing_attempts pa ON pa.event_pk = e.id
    WHERE e.id = $1 OR e.event_id = $1
    GROUP BY e.id`,
    [id],
  );

  return result.rows[0] ?? null;
};

export type ReplayFilters = {
  tenantId: string;
  from?: string;
  to?: string;
  type?: string;
  status?: 'FAILED' | 'DLQ' | 'COMPLETED';
  mode: ReplayMode;
  limit: number;
};

export const replayByFilter = async (client: PoolClient, filters: ReplayFilters): Promise<number> => {
  const where: string[] = ['tenant_id = $1'];
  const values: unknown[] = [filters.tenantId];

  if (filters.from) {
    where.push(`occurred_at >= $${values.length + 1}`);
    values.push(filters.from);
  }

  if (filters.to) {
    where.push(`occurred_at <= $${values.length + 1}`);
    values.push(filters.to);
  }

  if (filters.type) {
    where.push(`type = $${values.length + 1}`);
    values.push(filters.type);
  }

  if (filters.status) {
    where.push(`processing_status = $${values.length + 1}`);
    values.push(filters.status);
  }

  values.push(filters.limit);

  const rows = await client.query<{
    id: string;
    tenant_id: string;
    event_id: string;
    type: string;
    subject: string;
    partition_key: string;
    occurred_at: string;
    payload: Record<string, unknown>;
    source: string;
    schema_version: string;
    spec_version: string;
    hash: string;
    correlation_id: string;
  }>(
    `SELECT
      id,
      tenant_id,
      event_id,
      type,
      subject,
      partition_key,
      occurred_at,
      payload,
      source,
      schema_version,
      spec_version,
      hash,
      correlation_id
     FROM events
     WHERE ${where.join(' AND ')}
     ORDER BY occurred_at ASC
     LIMIT $${values.length}`,
    values,
  );

  let inserted = 0;
  for (const row of rows.rows) {
    await client.query(
      `INSERT INTO outbox (tenant_id, event_pk, queue, payload, status)
       VALUES ($1, $2, 'events.main', $3, 'PENDING')`,
      [
        row.tenant_id,
        row.id,
        {
          replay: true,
          replayMode: filters.mode,
          replayRequestedAt: new Date().toISOString(),
          eventPk: row.id,
          tenantId: row.tenant_id,
          eventId: row.event_id,
          type: row.type,
          subject: row.subject,
          partitionKey: row.partition_key,
          occurredAt: row.occurred_at,
          payload: row.payload,
          source: row.source,
          schemaVersion: row.schema_version,
          specVersion: row.spec_version,
          hash: row.hash,
          correlationId: row.correlation_id,
        },
      ],
    );

    if (filters.mode === 'reprocess') {
      await client.query(
        `UPDATE events
         SET processing_status = 'REPLAY_REQUESTED',
             last_error = NULL
         WHERE id = $1`,
        [row.id],
      );
    }

    inserted += 1;
  }

  return inserted;
};

export const getDlqReasons = async (
  client: PoolClient,
  input: { tenantId?: string; limit: number },
): Promise<Array<{ reasonCode: string; errorMessage: string; total: number }>> => {
  const where: string[] = [`status = 'DLQ'`];
  const values: unknown[] = [];

  if (input.tenantId) {
    values.push(input.tenantId);
    where.push(`tenant_id = $${values.length}`);
  }

  values.push(input.limit);

  const result = await client.query<{
    reason_code: string | null;
    error_message: string | null;
    total: string;
  }>(
    `SELECT
      COALESCE(reason_code, 'UNKNOWN') AS reason_code,
      COALESCE(error_message, 'unknown') AS error_message,
      COUNT(*)::text AS total
     FROM processing_attempts
     WHERE ${where.join(' AND ')}
     GROUP BY reason_code, error_message
     ORDER BY COUNT(*) DESC
     LIMIT $${values.length}`,
    values,
  );

  return result.rows.map((row) => ({
    reasonCode: row.reason_code ?? 'UNKNOWN',
    errorMessage: row.error_message ?? 'unknown',
    total: Number(row.total),
  }));
};

export const retryDlq = async (
  client: PoolClient,
  input: { tenantId?: string; limit: number },
): Promise<number> => {
  const where: string[] = [`e.processing_status = 'DLQ'`];
  const values: unknown[] = [];

  if (input.tenantId) {
    values.push(input.tenantId);
    where.push(`e.tenant_id = $${values.length}`);
  }

  values.push(input.limit);

  const result = await client.query<{
    id: string;
    tenant_id: string;
    event_id: string;
    type: string;
    subject: string;
    partition_key: string;
    occurred_at: string;
    payload: Record<string, unknown>;
    source: string;
    schema_version: string;
    spec_version: string;
    hash: string;
    correlation_id: string;
  }>(
    `SELECT
      e.id,
      e.tenant_id,
      e.event_id,
      e.type,
      e.subject,
      e.partition_key,
      e.occurred_at,
      e.payload,
      e.source,
      e.schema_version,
      e.spec_version,
      e.hash,
      e.correlation_id
     FROM events e
     WHERE ${where.join(' AND ')}
     ORDER BY e.updated_at DESC
     LIMIT $${values.length}`,
    values,
  );

  let retried = 0;
  for (const row of result.rows) {
    const pending = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
       FROM outbox
       WHERE event_pk = $1 AND status IN ('PENDING', 'FAILED', 'IN_FLIGHT')`,
      [row.id],
    );

    if (Number(pending.rows[0]?.total ?? '0') > 0) {
      continue;
    }

    await client.query(
      `INSERT INTO outbox (tenant_id, event_pk, queue, payload, status)
       VALUES ($1, $2, 'events.main', $3, 'PENDING')`,
      [
        row.tenant_id,
        row.id,
        {
          replay: true,
          replayMode: 'dlq-retry',
          replayRequestedAt: new Date().toISOString(),
          eventPk: row.id,
          tenantId: row.tenant_id,
          eventId: row.event_id,
          type: row.type,
          subject: row.subject,
          partitionKey: row.partition_key,
          occurredAt: row.occurred_at,
          payload: row.payload,
          source: row.source,
          schemaVersion: row.schema_version,
          specVersion: row.spec_version,
          hash: row.hash,
          correlationId: row.correlation_id,
        },
      ],
    );

    await client.query(
      `UPDATE events
       SET processing_status = 'REPLAY_REQUESTED',
           last_error = NULL
       WHERE id = $1`,
      [row.id],
    );

    retried += 1;
  }

  return retried;
};
