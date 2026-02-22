import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env } from './config.js';

export const dbPool = new Pool({
  connectionString: env.DATABASE_URL,
});

export const query = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> => dbPool.query<T>(text, params);

export const transaction = async <T>(run: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const value = await run(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
