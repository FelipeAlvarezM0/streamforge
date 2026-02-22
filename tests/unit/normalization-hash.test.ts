import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../../packages/shared/src/schemas.js';

describe('event normalization and hashing', () => {
  it('generates deterministic hashes for equivalent payloads', () => {
    const eventA = normalizeEvent(
      {
        eventId: 'evt-1',
        eventType: 'SALE',
        occurredAt: '2026-01-01T00:00:00.000Z',
        source: 'api',
        schemaVersion: '1.0.0',
        specVersion: '1.0',
        subject: 'order-1',
        payload: { b: 2, a: 1 },
      },
      'tenant-a',
      'corr-a',
    );

    const eventB = normalizeEvent(
      {
        eventId: 'evt-1',
        type: 'SALE',
        occurredAt: '2026-01-01T00:00:00.000Z',
        source: 'api',
        schemaVersion: '1.0.0',
        specVersion: '1.0',
        entityId: 'order-1',
        payload: { a: 1, b: 2 },
      },
      'tenant-a',
      'corr-b',
    );

    expect(eventA.hash).toBe(eventB.hash);
    expect(eventA.partitionKey).toBe('order-1');
  });
});
