import crypto from 'node:crypto';
import { env, type NormalizedEvent } from '@streamforge/shared';

const stableSort = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stableSort);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stableSort(record[key]);
        return acc;
      }, {});
  }
  return value;
};

const digest = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const intentMaterial = (event: NormalizedEvent): Record<string, unknown> => {
  const material: Record<string, unknown> = {
    tenantId: event.tenantId,
    type: event.type,
    subject: event.subject,
    partitionKey: event.partitionKey,
    source: event.source,
    schemaVersion: event.schemaVersion,
    specVersion: event.specVersion,
    payload: stableSort(event.payload),
  };

  if (env.DEDUPE_INCLUDE_OCCURRED_AT) {
    material.occurredAt = event.occurredAt;
  }

  return material;
};

export const makeDedupeHash = (event: NormalizedEvent, idempotencyKey?: string): string => {
  if (idempotencyKey) {
    return digest({ tenantId: event.tenantId, idempotencyKey: idempotencyKey.trim().toLowerCase() });
  }

  if (env.DEDUPE_STRATEGY === 'full') {
    return event.hash;
  }

  return digest(intentMaterial(event));
};
