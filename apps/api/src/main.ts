import cluster from 'node:cluster';
import os from 'node:os';
import { dbPool, env, logger, redis } from '@streamforge/shared';
import { createApi } from './app.js';

const startHttpServer = async (): Promise<void> => {
  const { app, close } = await createApi();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'API shutdown started');
    await app.close();
    await close();
    await redis.quit();
    await dbPool.end();
    logger.info('API shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: '0.0.0.0', port: env.API_PORT });
  logger.info({ port: env.API_PORT }, 'StreamForge API listening');
};

const main = async (): Promise<void> => {
  if (env.CLUSTER_ENABLED && cluster.isPrimary) {
    const targetWorkers = env.CLUSTER_WORKERS > 0 ? env.CLUSTER_WORKERS : Math.max(1, os.cpus().length - 1);
    logger.info({ workers: targetWorkers }, 'Cluster mode enabled');

    for (let i = 0; i < targetWorkers; i += 1) {
      cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
      logger.warn({ workerId: worker.id, code, signal }, 'Worker exited, spawning replacement');
      cluster.fork();
    });

    return;
  }

  await startHttpServer();
};

main().catch((error) => {
  logger.error({ error }, 'API failed to start');
  process.exitCode = 1;
});
