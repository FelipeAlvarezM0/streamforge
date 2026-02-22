import { describe, expect, it } from 'vitest';
import { computeRateLimitState } from '../../apps/api/src/rate-limit-utils.js';

describe('rate limit state', () => {
  it('returns remaining and reset values', () => {
    const state = computeRateLimitState(100, 70, 120);
    expect(state.remaining).toBe(30);
    expect(state.blocked).toBe(false);
    expect(state.resetSeconds).toBe(60);
  });

  it('flags blocked when current exceeds limit', () => {
    const state = computeRateLimitState(100, 101, 121);
    expect(state.remaining).toBe(0);
    expect(state.blocked).toBe(true);
  });
});
