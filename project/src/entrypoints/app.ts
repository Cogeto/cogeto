import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { assertAppKeyMount, describeErrorLine, runWithUsageContext } from '../infrastructure/index';
import { logRedactionState } from './redaction-boot';
import { loadConfig } from './config';
import { createLogger, PinoNestLogger } from './logger';
import { createAppRootModule } from './app-root.module';

/** app — the fast-path process: API, dashboard, connectors, approvals (§A.1). */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // QS-9: the internet-facing app must mount only the public signing key. When
  // the compose flag is set, assert the private key is not reachable — a
  // misconfigured mount fails the boot rather than exposing the signing key.
  if (process.env.COGETO_ASSERT_NO_PRIVATE_KEY === '1') {
    await assertAppKeyMount(config.instanceKeyDir);
    logger.info(
      { dir: config.instanceKeyDir },
      'signing-key mount verified: public key only (QS-9)',
    );
  }

  const app = await NestFactory.create(createAppRootModule(config) as never, {
    logger: new PinoNestLogger(logger),
  });
  // Open a per-request usage scope (FIX-2 QS-2) as the outermost middleware, so
  // the bearer guard can attribute the request to a principal and the gateway
  // budget decorator can meter/cap that principal's model calls. Non-API and
  // unauthenticated requests simply carry an empty scope.
  app.use((_req: Request, _res: Response, next: NextFunction) => runWithUsageContext(() => next()));
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  await app.listen(config.httpPort);
  // Effective serving mode (QS-3): make the demo/production posture explicit in
  // the boot log so an operator can see at a glance whether this instance
  // publishes the anonymous sandbox token.
  const mode = config.production
    ? 'production (demo session never served)'
    : config.demoMode
      ? 'DEMO SANDBOX (publishes a shared session token to anyone)'
      : 'standard (customer instance; no demo session served)';
  logger.info({ port: config.httpPort, mode }, `cogeto app listening — mode: ${mode}`);
  logRedactionState(logger, config);
}

// Top-level handlers log the error CLASS + a scrubbed, length-bounded message
// only — never the raw error, whose stack or `received "<value>"` fragment can
// carry secrets or model output (QS-22).
process.on('unhandledRejection', (reason: unknown) => {
  console.error(`unhandledRejection: ${describeErrorLine(reason)}`);
});
process.on('uncaughtException', (error: unknown) => {
  console.error(`uncaughtException: ${describeErrorLine(error)}`);
  process.exit(1);
});

main().catch((error: unknown) => {
  console.error(`app failed to start: ${describeErrorLine(error)}`);
  process.exit(1);
});
