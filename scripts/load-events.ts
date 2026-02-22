import fs from 'node:fs/promises';
import path from 'node:path';
import autocannon from 'autocannon';

const url = process.env.LOAD_EVENTS_URL ?? 'http://localhost:3000/v1/events';
const connections = Number(process.env.LOAD_CONNECTIONS ?? 100);
const duration = Number(process.env.LOAD_DURATION_SECONDS ?? 30);
const tenantId = process.env.LOAD_TENANT ?? 'tenant-load';

const eventTemplate = {
  eventType: 'SALE',
  source: 'load-script',
  schemaVersion: '1.0.0',
  specVersion: '1.0',
  subject: 'order',
  payload: {
    amount: 100,
    currency: 'USD',
  },
};

const result = await autocannon({
  url,
  method: 'POST',
  connections,
  duration,
  headers: {
    'content-type': 'application/json',
    'x-tenant-id': tenantId,
  },
  setupRequest: (request) => {
    const now = new Date().toISOString();
    const subject = `order-${Math.floor(Math.random() * 10000)}`;
    const body = JSON.stringify({
      ...eventTemplate,
      eventId: `load-${Date.now()}-${Math.random()}`,
      occurredAt: now,
      subject,
      partitionKey: subject,
      payload: {
        ...eventTemplate.payload,
        trace: `${Math.random()}`,
      },
    });

    return {
      ...request,
      body,
    };
  },
});

const report = {
  startedAt: new Date().toISOString(),
  url,
  connections,
  duration,
  requests: result.requests,
  latency: result.latency,
  throughput: result.throughput,
  non2xx: result['non2xx'],
};

const reportName = `load-events-${Date.now()}.json`;
const reportPath = path.resolve('reports', reportName);
await fs.mkdir(path.resolve('reports'), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify({ reportPath, summary: report }, null, 2));
