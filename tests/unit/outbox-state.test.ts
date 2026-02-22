import { describe, expect, it } from 'vitest';
import { nextOutboxStatusOnPublish } from '../../apps/publisher/src/state.js';

describe('outbox status transitions', () => {
  it('moves to published on success', () => {
    expect(nextOutboxStatusOnPublish('IN_FLIGHT', true)).toBe('PUBLISHED');
  });

  it('moves to failed on failure', () => {
    expect(nextOutboxStatusOnPublish('IN_FLIGHT', false)).toBe('FAILED');
  });

  it('preserves published state on repeated success', () => {
    expect(nextOutboxStatusOnPublish('PUBLISHED', true)).toBe('PUBLISHED');
  });
});
