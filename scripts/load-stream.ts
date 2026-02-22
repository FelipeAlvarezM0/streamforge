import fs from 'node:fs/promises';
import path from 'node:path';
import autocannon from 'autocannon';

const url = process.env.LOAD_STREAM_URL ?? 'http://localhost:3000/v1/ingest/stream';
const connections = Number(process.env.LOAD_CONNECTIONS ?? 20);
const duration = Number(process.env.LOAD_DURATION_SECONDS ?? 20);
const tenantId = process.env.LOAD_TENANT ?? 'tenant-load-stream';
const linesPerRequest = Number(process.env.LOAD_STREAM_LINES ?? 200);

const buildBody = (): string => {
  const now = new Date();
  const lines: string[] = [];

  for (let i = 0; i < linesPerRequest; i += 1) {
    const subject = `order-${i % 50}`;
    lines.push(
      JSON.stringify({
        eventId: `stream-${Date.now()}-${i}-${Math.random()}`,
        eventType: i % 2 === 0 ? 'PAYMENT' : 'SALE',
        subject,
        partitionKey: subject,
        occurredAt: new Date(now.getTime() - i * 50).toISOString(),
        source: 'load-stream',
        schemaVersion: '1.0.0',
        specVersion: '1.0',
        payload: {
          line: i,
          amount: Math.floor(Math.random() * 1000),
          currency: 'USD',
        },
      }),
    );
  }

  return `${lines.join('\n')}\n`;
};

const result = await autocannon({
  url,
  method: 'POST',
  connections,
  duration,
  headers: {
    'content-type': 'application/x-ndjson',
    'x-tenant-id': tenantId,
  },
  setupRequest: (request) => ({
    ...request,
    body: buildBody(),
  }),
});

const report = {
  startedAt: new Date().toISOString(),
  url,
  connections,
  duration,
  linesPerRequest,
  requests: result.requests,
  latency: result.latency,
  throughput: result.throughput,
  non2xx: result['non2xx'],
};

const reportName = `load-stream-${Date.now()}.json`;
const reportPath = path.resolve('reports', reportName);
await fs.mkdir(path.resolve('reports'), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify({ reportPath, summary: report }, null, 2));
