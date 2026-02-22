import type { FastifyReply, FastifyRequest } from 'fastify';
import { env, redis } from '@streamforge/shared';
import { WINDOW_SECONDS, computeRateLimitState } from './rate-limit-utils.js';

type RateLimitResult = {
  limit: number;
  remaining: number;
  resetSeconds: number;
  blocked: boolean;
};

export const consumeRateLimit = async (tenantId: string): Promise<RateLimitResult> => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = nowSeconds - (nowSeconds % WINDOW_SECONDS);
  const key = `ratelimit:${tenantId}:${windowStart}`;

  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, WINDOW_SECONDS + 1);
  }

  const limit = env.TENANT_RATE_LIMIT_PER_MINUTE;
  const state = computeRateLimitState(limit, current, nowSeconds);

  return {
    limit,
    remaining: state.remaining,
    resetSeconds: state.resetSeconds,
    blocked: state.blocked,
  };
};

export const applyRateLimitHeaders = (reply: FastifyReply, result: RateLimitResult): void => {
  reply.header('RateLimit-Limit', result.limit.toString());
  reply.header('RateLimit-Remaining', result.remaining.toString());
  reply.header('RateLimit-Reset', result.resetSeconds.toString());
};

export const tenantRateLimit = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const tenantId = request.headers['x-tenant-id'];

  if (!tenantId || Array.isArray(tenantId)) {
    reply.code(400).send({ message: 'X-Tenant-Id header is required' });
    return;
  }

  const result = await consumeRateLimit(tenantId);
  applyRateLimitHeaders(reply, result);

  if (result.blocked) {
    reply.code(429).send({
      message: 'Rate limit exceeded',
      tenantId,
    });
    return;
  }
};
