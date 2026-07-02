import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from './config';
import { createLogger, PinoNestLogger } from './logger';
import { createAppRootModule } from './app-root.module';

/** app — the fast-path process: API, dashboard, connectors, approvals (§A.1). */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const app = await NestFactory.create(createAppRootModule(config) as never, {
    logger: new PinoNestLogger(logger),
  });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  await app.listen(config.httpPort);
  logger.info({ port: config.httpPort }, 'cogeto app listening');
}

main().catch((error: unknown) => {
  console.error('app failed to start:', error);
  process.exit(1);
});
