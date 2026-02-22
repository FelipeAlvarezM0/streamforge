import dotenv from 'dotenv';
import pino from 'pino';
import { Pool } from 'pg';

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const retentionDays = Number(process.env.IDEMPOTENCY_DB_RETENTION_DAYS ?? 90);

const main = async (): Promise<void> => {
  const result = await pool.query<{ deleted: string }>(
    `WITH deleted AS (
       DELETE FROM idempotency_keys
       WHERE first_seen_at < NOW() - make_interval(days => $1::int)
       RETURNING 1
     )
     SELECT COUNT(*)::text AS deleted FROM deleted`,
    [retentionDays],
  );

  logger.info({ retentionDays, deleted: Number(result.rows[0]?.deleted ?? '0') }, 'Pruned idempotency keys');
  await pool.end();
};

main().catch(async (error) => {
  logger.error({ error }, 'Failed to prune idempotency keys');
  await pool.end();
  process.exitCode = 1;
});
