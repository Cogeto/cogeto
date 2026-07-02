import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { run } from 'graphile-worker';
import type { Runner } from 'graphile-worker';
import { loadConfig } from './config';
import { createLogger, PinoNestLogger } from './logger';
import { createWorkerRootModule } from './worker-root.module';
import { createDb } from '../infrastructure/index';
import { buildTaskList } from './worker-tasks';

const HEARTBEAT_FILE = '/tmp/worker-heartbeat';
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * worker — the slow-path process (§A.1): Graphile Worker runner over the
 * Postgres queue (§A.3) plus the Nest application context for module services.
 * No HTTP. Assumes migrations already ran (init container, §A.2).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const context = await NestFactory.createApplicationContext(
    createWorkerRootModule(config) as never,
    { logger: new PinoNestLogger(logger) },
  );
  context.enableShutdownHooks();

  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = createDb(pool);
  const runner: Runner = await run({
    pgPool: pool,
    concurrency: 2,
    taskList: buildTaskList(db),
    noHandleSignals: true,
  });
  logger.info('cogeto worker started (graphile runner + task registry)');

  const heartbeat = setInterval(() => {
    void writeFile(HEARTBEAT_FILE, new Date().toISOString()).catch((error: unknown) => {
      logger.warn({ error: String(error) }, 'heartbeat write failed');
    });
  }, HEARTBEAT_INTERVAL_MS);
  await writeFile(HEARTBEAT_FILE, new Date().toISOString());

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    await runner.stop();
    await pool.end();
    await context.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error('worker failed to start:', error);
  process.exit(1);
});
