import type { PoolClient } from 'pg';
import { dedupeCounter, env, redis, transaction, type NormalizedEvent } from '@streamforge/shared';
import { makeDedupeHash } from './dedupe-utils.js';
import { insertEventAndOutbox } from './repository.js';

export type EnqueueResult = {
  accepted: boolean;
  duplicate: boolean;
  duplicateLayer?: 'redis' | 'postgres';
  eventPk?: string;
  outboxId?: number;
};

type Reservation = {
  key: string;
  reserved: boolean;
};

const reserveRedis = async (tenantId: string, hash: string): Promise<Reservation> => {
  const key = `dedupe:${tenantId}:${hash}`;

  try {
    const result = await redis.set(key, '1', 'EX', env.IDEMPOTENCY_TTL_SECONDS, 'NX');
    return { key, reserved: result === 'OK' };
  } catch {
    return { key, reserved: false };
  }
};

const releaseRedis = async (key: string): Promise<void> => {
  try {
    await redis.del(key);
  } catch {
    // Best-effort cleanup only.
  }
};

const reserveDbIdempotency = async (client: PoolClient, tenantId: string, hash: string): Promise<boolean> => {
  const result = await client.query(
    `INSERT INTO idempotency_keys(tenant_id, hash)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, hash) DO NOTHING`,
    [tenantId, hash],
  );

  return (result.rowCount ?? 0) > 0;
};

export const enqueueEvent = async (
  event: NormalizedEvent,
  idempotencyKey?: string,
  reservedRedis?: Reservation,
): Promise<EnqueueResult> => {
  const dedupeHash = makeDedupeHash(event, idempotencyKey);
  const redisReservation = reservedRedis ?? (await reserveRedis(event.tenantId, dedupeHash));

  if (!redisReservation.reserved && !reservedRedis) {
    dedupeCounter.inc({ tenantId: event.tenantId, layer: 'redis' });
    return { accepted: false, duplicate: true, duplicateLayer: 'redis' };
  }

  try {
    return await transaction(async (client) => {
      const dbReserved = await reserveDbIdempotency(client, event.tenantId, dedupeHash);
      if (!dbReserved) {
        dedupeCounter.inc({ tenantId: event.tenantId, layer: 'postgres' });
        return { accepted: false, duplicate: true, duplicateLayer: 'postgres' };
      }

      const persisted = await insertEventAndOutbox(client, event);
      return {
        accepted: true,
        duplicate: false,
        eventPk: persisted.eventPk,
        outboxId: persisted.outboxId,
      };
    });
  } catch (error) {
    if (redisReservation.reserved) {
      await releaseRedis(redisReservation.key);
    }
    throw error;
  }
};

export const reserveDedupeOnly = async (
  event: NormalizedEvent,
  idempotencyKey?: string,
): Promise<{ duplicate: boolean; reservation?: Reservation }> => {
  const dedupeHash = makeDedupeHash(event, idempotencyKey);
  const reservation = await reserveRedis(event.tenantId, dedupeHash);
  if (!reservation.reserved) {
    dedupeCounter.inc({ tenantId: event.tenantId, layer: 'redis' });
    return { duplicate: true };
  }

  return {
    duplicate: false,
    reservation,
  };
};
