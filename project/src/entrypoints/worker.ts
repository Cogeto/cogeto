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
import { ACTIVE_PROMPTS, IngestionPipeline } from '../ingestion/index';
import { MemoryStore } from '../memory/index';
import { loadPrompt, recordPromptVersion } from '../model-gateway/index';
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

  // Register the active prompt versions (§B.7) — also the immutability check:
  // a released version whose file hash changed fails the boot.
  for (const ref of ACTIVE_PROMPTS) {
    const prompt = await loadPrompt(ref.family, ref.version);
    await recordPromptVersion(db, prompt);
    logger.info(
      { family: prompt.family, version: prompt.version, sha256: prompt.contentHash.slice(0, 12) },
      'prompt version registered',
    );
  }

  // Idempotent Qdrant collection + payload-index creation (§A.4).
  await context.get(MemoryStore).ensureIndexReady();
  logger.info('memory vector collection ready');

  const pipeline = context.get(IngestionPipeline);
  const runner: Runner = await run({
    pgPool: pool,
    concurrency: 2,
    taskList: buildTaskList(db, {
      pipeline,
      log: (event, message) => logger.info(event, message),
    }),
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
