import dotenv from 'dotenv';
import pino from 'pino';
import { Pool } from 'pg';

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });

const seed = async (): Promise<void> => {
  await dbPool.query(
    `INSERT INTO events (
      tenant_id,
      event_id,
      type,
      subject,
      partition_key,
      occurred_at,
      payload,
      source,
      schema_version,
      spec_version,
      hash,
      correlation_id,
      processing_status
    ) VALUES (
      'tenant-demo',
      'seed-event-1',
      'SALE',
      'order-100',
      'order-100',
      NOW(),
      '{"amount": 100, "currency": "USD"}'::jsonb,
      'seed',
      '1.0.0',
      '1.0',
      'seed-hash-1',
      'seed-correlation-1',
      'COMPLETED'
    ) ON CONFLICT DO NOTHING`,
  );

  logger.info('Seed completed');
  await dbPool.end();
};

seed().catch(async (error) => {
  logger.error({ error }, 'Seed failed');
  await dbPool.end();
  process.exitCode = 1;
});
