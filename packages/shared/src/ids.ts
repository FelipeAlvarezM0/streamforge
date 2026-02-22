import { v4 as uuidv4 } from 'uuid';

export const correlationIdOrNew = (value?: string): string => value?.trim() || uuidv4();

export const idempotencyKeyToHash = (value: string): string => value.trim().toLowerCase();
