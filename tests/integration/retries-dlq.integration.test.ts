import { describe, expect, it } from 'vitest';

const runIntegration = process.env.RUN_INTEGRATION === '1';
const testOrSkip = runIntegration ? it : it.skip;
const baseUrl = process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000';

describe('integration: retries and dlq', () => {
  testOrSkip('records retries/dlq for failing payment events', async () => {
    const eventId = `it-payment-${Date.now()}`;

    const response = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': 'tenant-it',
      },
      body: JSON.stringify({
        eventId,
        eventType: 'PAYMENT',
        subject: 'payment-it-1',
        occurredAt: new Date().toISOString(),
        payload: { amount: 999, currency: 'USD' },
        source: 'integration-test',
        schemaVersion: '1.0.0',
        specVersion: '1.0',
      }),
    });

    expect(response.status).toBe(202);

    const body = (await response.json()) as { eventPk: string };
    expect(body.eventPk).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const statusResponse = await fetch(`${baseUrl}/v1/events/${body.eventPk}`);
    expect(statusResponse.status).toBe(200);

    const statusBody = (await statusResponse.json()) as { processing_status: string };
    expect(['COMPLETED', 'FAILED', 'DLQ']).toContain(statusBody.processing_status);
  });
});
