import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from './config';
import { createLogger, PinoNestLogger } from './logger';
import { createWorkerRootModule } from './worker-root.module';

const HEARTBEAT_FILE = '/tmp/worker-heartbeat';
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * worker — the slow-path process (§A.1): boots a Nest application context
 * without HTTP. Graphile Worker job execution arrives in S1-B; for now the
 * process proves the composition root and emits a heartbeat for its
 * container healthcheck.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const context = await NestFactory.createApplicationContext(
    createWorkerRootModule(config) as never,
    { logger: new PinoNestLogger(logger) },
  );
  context.enableShutdownHooks();
  logger.info('cogeto worker started (job runner arrives in S1-B)');

  const heartbeat = setInterval(() => {
    void writeFile(HEARTBEAT_FILE, new Date().toISOString()).catch((error: unknown) => {
      logger.warn({ error: String(error) }, 'heartbeat write failed');
    });
  }, HEARTBEAT_INTERVAL_MS);
  await writeFile(HEARTBEAT_FILE, new Date().toISOString());

  const shutdown = async (): Promise<void> => {
    clearInterval(heartbeat);
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
