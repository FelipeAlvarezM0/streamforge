import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pino from 'pino';
import { Pool } from 'pg';

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../migrations/sql');

const ensureMigrationsTable = async (): Promise<void> => {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

const alreadyApplied = async (version: string): Promise<boolean> => {
  const result = await dbPool.query<{ version: string }>('SELECT version FROM schema_migrations WHERE version = $1', [version]);
  return result.rowCount > 0;
};

const applyMigration = async (version: string, sql: string): Promise<void> => {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
    await client.query('COMMIT');
    logger.info({ version }, 'Migration applied');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const main = async (): Promise<void> => {
  await ensureMigrationsTable();
  const files = (await fs.readdir(migrationsDir)).filter((item) => item.endsWith('.sql')).sort();

  for (const file of files) {
    if (await alreadyApplied(file)) {
      continue;
    }
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    await applyMigration(file, sql);
  }

  await dbPool.end();
};

main().catch(async (error) => {
  logger.error({ error }, 'Migration failed');
  await dbPool.end();
  process.exitCode = 1;
});
