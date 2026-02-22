import pino from 'pino';
import { env } from './config.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: null,
  messageKey: 'message',
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const childLogger = (bindings: Record<string, unknown>) => logger.child(bindings);
