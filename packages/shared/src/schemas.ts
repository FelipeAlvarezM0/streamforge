import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const payloadSchema = z
  .record(z.any())
  .or(z.array(z.any()))
  .or(z.string())
  .or(z.number())
  .or(z.boolean())
  .or(z.null());

export const eventTypeSchema = z.enum(['SALE', 'INVOICE', 'PAYMENT', 'REFUND', 'SHIPMENT']);

const incomingEnvelopeSchema = z
  .object({
    eventId: z.string().optional(),
    eventType: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    occurredAt: z.string().datetime(),
    payload: payloadSchema,
    source: z.string().default('api'),
    schemaVersion: z.string().default('1.0.0'),
    specVersion: z.string().default('1.0'),
    subject: z.string().min(1).optional(),
    entityId: z.string().min(1).optional(),
    partitionKey: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.eventType && !value.type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either eventType or type must be provided',
      });
    }
    if (!value.subject && !value.entityId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either subject or entityId must be provided',
      });
    }
  })
  .transform((value) => {
    const subject = value.subject ?? value.entityId ?? '';
    return {
      eventId: value.eventId,
      type: value.eventType ?? value.type ?? '',
      occurredAt: value.occurredAt,
      payload: value.payload,
      source: value.source,
      schemaVersion: value.schemaVersion,
      specVersion: value.specVersion,
      subject,
      partitionKey: value.partitionKey ?? subject,
    };
  });

export const incomingEventSchema = incomingEnvelopeSchema;

export const normalizedEventSchema = z.object({
  eventId: z.string().min(1),
  tenantId: z.string().min(1),
  type: z.string().min(1),
  occurredAt: z.string().datetime(),
  payload: payloadSchema,
  source: z.string().min(1),
  schemaVersion: z.string().min(1),
  specVersion: z.string().min(1),
  subject: z.string().min(1),
  partitionKey: z.string().min(1),
  hash: z.string().length(64),
  correlationId: z.string().min(1),
});

export type IncomingEvent = z.input<typeof incomingEventSchema>;
export type IncomingEnvelope = z.output<typeof incomingEventSchema>;
export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;

type Payload = NormalizedEvent['payload'];

export const sortRecursively = (value: unknown): Payload => {
  if (Array.isArray(value)) {
    return value.map(sortRecursively);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortRecursively(record[key]);
        return acc;
      }, {});
  }
  return value as Payload;
};

const hashMaterial = (event: Omit<NormalizedEvent, 'hash'>): Record<string, unknown> => ({
  tenantId: event.tenantId,
  type: event.type,
  occurredAt: event.occurredAt,
  payload: sortRecursively(event.payload),
  source: event.source,
  schemaVersion: event.schemaVersion,
  specVersion: event.specVersion,
  subject: event.subject,
  partitionKey: event.partitionKey,
});

export const computeHash = (event: Omit<NormalizedEvent, 'hash'>): string =>
  crypto.createHash('sha256').update(JSON.stringify(hashMaterial(event))).digest('hex');

export const normalizeEvent = (
  input: IncomingEvent,
  tenantId: string,
  correlationId: string,
): NormalizedEvent => {
  const parsed = incomingEventSchema.parse(input);

  const candidate: Omit<NormalizedEvent, 'hash'> = {
    eventId: parsed.eventId ?? uuidv4(),
    tenantId,
    type: parsed.type,
    occurredAt: parsed.occurredAt,
    payload: sortRecursively(parsed.payload),
    source: parsed.source,
    schemaVersion: parsed.schemaVersion,
    specVersion: parsed.specVersion,
    subject: parsed.subject,
    partitionKey: parsed.partitionKey,
    correlationId,
  };

  const hash = computeHash(candidate);
  return normalizedEventSchema.parse({ ...candidate, hash });
};
