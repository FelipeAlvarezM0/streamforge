import { describe, expect, it } from 'vitest';

const runIntegration = process.env.RUN_INTEGRATION === '1';
const testOrSkip = runIntegration ? it : it.skip;

const baseUrl = process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000';

describe('integration: ingest -> outbox -> publish -> worker', () => {
  testOrSkip('accepts event and exposes processing status', async () => {
    const eventId = `it-${Date.now()}`;
    const response = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': 'tenant-it',
        'X-Correlation-Id': `corr-${eventId}`,
      },
      body: JSON.stringify({
        eventId,
        eventType: 'SALE',
        subject: 'order-it-1',
        occurredAt: new Date().toISOString(),
        payload: { amount: 123, currency: 'USD' },
        source: 'integration-test',
        schemaVersion: '1.0.0',
        specVersion: '1.0',
      }),
    });

    expect(response.status).toBe(202);

    const body = (await response.json()) as { eventPk: string };
    expect(body.eventPk).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const statusResponse = await fetch(`${baseUrl}/v1/events/${body.eventPk}`);
    expect(statusResponse.status).toBe(200);
  });
});
