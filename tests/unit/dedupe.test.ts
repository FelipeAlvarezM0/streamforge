import { describe, expect, it } from 'vitest';
import { makeDedupeHash } from '../../apps/api/src/dedupe-utils.js';

const sampleEvent = {
  eventId: 'evt-1',
  tenantId: 'tenant-a',
  type: 'SALE',
  occurredAt: '2026-01-01T00:00:00.000Z',
  payload: { amount: 10 },
  source: 'api',
  schemaVersion: '1.0.0',
  specVersion: '1.0',
  subject: 'order-1',
  partitionKey: 'order-1',
  hash: 'a'.repeat(64),
  correlationId: 'corr-1',
};

describe('dedupe hash', () => {
  it('creates stable dedupe hash from idempotency key when present', () => {
    const first = makeDedupeHash(sampleEvent, 'IDEMP-KEY');
    const second = makeDedupeHash({ ...sampleEvent, hash: 'b'.repeat(64) }, 'IDEMP-KEY');

    expect(first).toHaveLength(64);
    expect(first).toBe(second);
  });

  it('returns deterministic hash without idempotency key', () => {
    const first = makeDedupeHash(sampleEvent);
    const second = makeDedupeHash({ ...sampleEvent, correlationId: 'corr-2' });
    expect(first).toBe(second);
  });
});
