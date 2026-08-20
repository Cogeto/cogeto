import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import { createDb } from '../infrastructure/index';
import type { LiveModelConfiguration } from '../model-gateway/index';
import {
  ManagedReconcileError,
  ProviderConfigService,
  reconcileManagedProvider,
} from '../providers/index';
import { redactionOptions } from './config';
import type { CogetoConfig } from './config';

/**
 * The managed provider's boot step (hosted provisioning, task A).
 *
 * Both composition roots call this between `installModelConfiguration` and the
 * embedding-space guard. This file is the ONLY place the two managed
 * environment variables are read, and `model-config-env.spec.ts` holds it to
 * that: the conscious, narrow walk-back of the v1.7.0 rule is exactly this
 * path, and everything else about model configuration stays interface-only.
 *
 * The split of responsibilities is deliberate: entrypoints read the
 * environment and the file (only entrypoints read the environment, AGENTS.md);
 * the providers module owns what the contents mean and what reconciling them
 * does.
 */
export async function reconcileManagedProviderAtBoot(
  config: CogetoConfig,
  live: LiveModelConfiguration,
  logger?: Logger,
): Promise<void> {
  const filePath = process.env.COGETO_MANAGED_PROVIDER_FILE?.trim() || null;
  const apiKey = process.env.COGETO_MANAGED_PROVIDER_API_KEY?.trim() || null;
  if (filePath === null && apiKey === null) return; // no managed provider, byte-identical

  let fileContent: string | null = null;
  if (filePath !== null) {
    try {
      fileContent = readFileSync(filePath, 'utf8');
    } catch {
      throw new ManagedReconcileError(
        `COGETO_MANAGED_PROVIDER_FILE points at ${filePath}, which cannot be read; ` +
          `fix the mount or unset the variable, then restart`,
      );
    }
  }

  // The full per-process pool size, not a bootstrap-sized one: the first
  // embeddings assignment drives the rebuild engine, whose single-flight
  // transaction, pass queries and switch transaction are concurrently open
  // connections. A two-connection pool deadlocks exactly there.
  const pool = new Pool({ connectionString: config.databaseUrl, max: config.pgPoolMax });
  try {
    const db = createDb(pool);
    const service = new ProviderConfigService(db, {
      live,
      masterKey: config.masterKey,
      redacted: config.redactionEnabled,
      reasoningHeadroom: config.modelProviders.reasoningHeadroom,
      timeoutsMs: config.modelProviders.timeoutsMs,
      trustScoresDir: config.trustScoresDir,
      pollIntervalMs: 0,
    });
    const redaction = redactionOptions(config);
    await reconcileManagedProvider(
      { fileContent, fileSource: filePath, apiKey },
      {
        db,
        service,
        masterKey: config.masterKey,
        qdrant: {
          url: config.qdrantUrl,
          ...(config.qdrantApiKey ? { apiKey: config.qdrantApiKey } : {}),
        },
        activeEmbeddingModel: config.modelProviders.tiers.embedding.model,
        ...(redaction ? { redaction } : {}),
        ...(logger ? { log: (message: string) => logger.info(message) } : {}),
      },
    );
  } finally {
    await pool.end();
  }
}
