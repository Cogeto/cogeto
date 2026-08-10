import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { raw } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { assertAppKeyMount, describeErrorLine, runWithUsageContext } from '../infrastructure/index';
import { logRedactionState } from './redaction-boot';
import {
  assertEmbeddingSpaceConsistent,
  installModelConfiguration,
  logModelConfiguration,
} from './model-boot';
import { assertLocalRuntimeReady } from '../model-gateway/index';
import { CapabilitiesService, formatCapabilitiesBanner } from '../operations/index';
import { loadConfig } from './config';
import { createLogger, PinoNestLogger } from './logger';
import { createAppRootModule } from './app-root.module';

/** app — the fast-path process: API, dashboard, connectors, approvals (spec §15). */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // the internet-facing app must mount only the public signing key. When
  // the compose flag is set, assert the private key is not reachable — a
  // misconfigured mount fails the boot rather than exposing the signing key.
  if (process.env.COGETO_ASSERT_NO_PRIVATE_KEY === '1') {
    await assertAppKeyMount(config.instanceKeyDir);
    logger.info({ dir: config.instanceKeyDir }, 'signing-key mount verified: public key only');
  }

  // The DATABASE's model configuration, in force before anything is built
  // (V2.4 item 7.1). Seeds the environment in on the first start after the
  // upgrade; after that the environment's model variables are ignored.
  const live = await installModelConfiguration(config, logger);

  // Embedding-space guard: a changed embeddings
  // model refuses boot until reindex has re-embedded the stored vectors.
  await assertEmbeddingSpaceConsistent(config);
  // Local-runtime probe: an unreachable Ollama
  // runtime or a never-pulled model refuses boot, never fails at first request.
  await assertLocalRuntimeReady(config.modelProviders);

  const app = await NestFactory.create(createAppRootModule(config, live) as never, {
    logger: new PinoNestLogger(logger),
  });
  // Open a per-request usage scope as the outermost middleware, so
  // the bearer guard can attribute the request to a principal and the gateway
  // budget decorator can meter/cap that principal's model calls. Non-API and
  // unauthenticated requests simply carry an empty scope.
  app.use((_req: Request, _res: Response, next: NextFunction) => runWithUsageContext(() => next()));
  // The email-intake endpoint receives the
  // raw RFC822 as the request body — the message-sized limit is far above the
  // default JSON parser's, and the raw parser hands the controller a Buffer. The
  // JSON/urlencoded parsers skip it by content-type (message/rfc822).
  app.use('/api/email/intake', raw({ type: () => true, limit: config.mailMaxBytes }));
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  await app.listen(config.httpPort);
  // Effective serving mode: make the demo/production posture explicit in
  // the boot log so an operator can see at a glance whether this instance
  // publishes the anonymous sandbox token.
  const mode = config.production
    ? 'production (demo session never served)'
    : config.demoMode
      ? 'DEMO SANDBOX (publishes a shared session token to anyone)'
      : 'standard (customer instance; no demo session served)';
  logger.info({ port: config.httpPort, mode }, `cogeto app listening, mode: ${mode}`);
  logRedactionState(logger, config);
  logModelConfiguration(logger, config); // State the active configuration id.
  // boot banner: one delimited line of exact capability
  // truth, every boot — the same registry snapshot the panel and /api/health
  // serve. Best-effort: a failed probe set must not take the app down, but the
  // failure itself is stated, never swallowed into silence.
  try {
    const snapshot = await app.get(CapabilitiesService).snapshot();
    logger.info({ banner: 'capabilities' }, formatCapabilitiesBanner(snapshot, new Date()));
  } catch (error) {
    logger.warn(
      { banner: 'capabilities' },
      `capability boot banner unavailable: ${describeErrorLine(error)}`,
    );
  }
}

// Top-level handlers log the error CLASS + a scrubbed, length-bounded message
// only — never the raw error, whose stack or `received "<value>"` fragment can
// carry secrets or model output.
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
