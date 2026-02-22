import type { FastifyReply, FastifyRequest } from 'fastify';
import { env, redis } from '@streamforge/shared';

const ADMIN_WINDOW_SECONDS = 60;

export const getHeaderValue = (headers: FastifyRequest['headers'], key: string): string | undefined => {
  const value = headers[key.toLowerCase() as keyof typeof headers];
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  return value;
};

const isTenantAllowed = (tenantId: string): boolean => {
  if (env.TENANT_ALLOWLIST.length === 0) {
    return true;
  }
  return env.TENANT_ALLOWLIST.includes(tenantId);
};

export const requireTenant = (request: FastifyRequest, reply: FastifyReply): string | undefined => {
  const tenantId = getHeaderValue(request.headers, 'x-tenant-id');
  if (!tenantId) {
    reply.code(400).send({ message: 'X-Tenant-Id header is required' });
    return undefined;
  }

  if (!isTenantAllowed(tenantId)) {
    reply.code(403).send({ message: 'Tenant is not allowed', tenantId });
    return undefined;
  }

  return tenantId;
};

const consumeAdminRateLimit = async (): Promise<{ blocked: boolean; remaining: number; resetSeconds: number }> => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = nowSeconds - (nowSeconds % ADMIN_WINDOW_SECONDS);
  const key = `ratelimit:admin:${windowStart}`;

  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, ADMIN_WINDOW_SECONDS + 1);
  }

  const remaining = Math.max(0, env.ADMIN_RATE_LIMIT_PER_MINUTE - current);
  return {
    blocked: current > env.ADMIN_RATE_LIMIT_PER_MINUTE,
    remaining,
    resetSeconds: ADMIN_WINDOW_SECONDS - (nowSeconds % ADMIN_WINDOW_SECONDS),
  };
};

export const adminGuard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const adminToken = getHeaderValue(request.headers, 'x-admin-token');
  if (!adminToken || adminToken !== env.ADMIN_TOKEN) {
    reply.code(401).send({ message: 'Unauthorized admin request' });
    return;
  }

  const rateLimit = await consumeAdminRateLimit();
  reply.header('RateLimit-Limit', env.ADMIN_RATE_LIMIT_PER_MINUTE.toString());
  reply.header('RateLimit-Remaining', rateLimit.remaining.toString());
  reply.header('RateLimit-Reset', rateLimit.resetSeconds.toString());

  if (rateLimit.blocked) {
    reply.code(429).send({ message: 'Admin rate limit exceeded' });
    return;
  }
};
