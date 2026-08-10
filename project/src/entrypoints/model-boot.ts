import { Pool } from 'pg';
import type { Logger } from 'pino';
import { createDb } from '../infrastructure/index';
import { listForeignEmbeddingModels, vectorIndexDimensionMismatch } from '../memory/index';
import { LiveModelConfiguration } from '../model-gateway/index';
import type { ResolvedModelProviders } from '../model-gateway/index';
import { loadModelConfiguration } from '../providers/index';
import type { CogetoConfig } from './config';

/**
 * Put the DATABASE's model configuration in force (V2.4 item 7.1).
 *
 * Called by every process that talks to a model, before anything is built. It
 * seeds the environment in once (the first start after the upgrade), then
 * replaces `config.modelProviders` with what the instance actually runs, so
 * every consumer downstream — the gateway, the embedding guard, the capability
 * registry, the reports, the boot log — reads one object and cannot disagree.
 *
 * The returned holder is the same object: it is what lets a saved assignment
 * reach a running process without a restart.
 *
 * A process that cannot reach the database does not start, which is already
 * true of every process here for other reasons; there is deliberately no
 * "fall back to the environment" path, because falling back would mean an
 * instance quietly running a configuration its admin replaced.
 */
export async function installModelConfiguration(
  config: CogetoConfig,
  logger?: Logger,
): Promise<LiveModelConfiguration> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  try {
    const loaded = await loadModelConfiguration(createDb(pool), {
      environment: config.modelProviders,
      masterKey: config.masterKey,
      redacted: config.redactionEnabled,
      reasoningHeadroom: config.modelProviders.reasoningHeadroom,
      timeoutsMs: config.modelProviders.timeoutsMs,
    });
    if (loaded.seeded) {
      logger?.info(
        { providers: loaded.seededProviders, configuration: loaded.providers.id },
        loaded.seededProviders > 0
          ? `model configuration seeded from the environment into the database ` +
              `(${loaded.seededProviders} provider(s)); the COGETO_MODEL_* and ` +
              `COGETO_PROVIDER_* variables are ignored from now on and may be removed`
          : 'no model configuration in the environment to seed; configure providers in Settings',
      );
    }
    const live = new LiveModelConfiguration(loaded.providers);
    // The config object now CARRIES the live object rather than a copy of it,
    // which is what makes every consumer that was handed `config.modelProviders`
    // current for the life of the process.
    (config as { modelProviders: ResolvedModelProviders }).modelProviders = live.current;
    return live;
  } finally {
    await pool.end();
  }
}

/**
 * Model-configuration boot surface: every boot states
 * the ACTIVE configuration id and per-tier bindings loudly — changing the
 * configuration mid-life is supported, the id changes, and the boot log states
 * it. Never logs keys.
 */
export function logModelConfiguration(logger: Logger, config: CogetoConfig): void {
  const p = config.modelProviders;
  if (!p.configured) {
    logger.warn(
      { configuration: 'unconfigured' },
      'model gateway not configured, model features disabled until a provider key is set',
    );
    return;
  }
  const tier = (t: 'pipeline' | 'answer' | 'embedding'): string =>
    `${p.tiers[t].provider}/${p.tiers[t].model}`;
  logger.info(
    {
      configuration: p.id,
      // Where the configuration came from (V2.4 item 7.1). Logged because an
      // operator staring at a `.env` that no longer does anything is the one
      // confusion this change can cause, and one word prevents it.
      source: p.source,
      pipeline: tier('pipeline'),
      answer: tier('answer'),
      embeddings: tier('embedding'),
    },
    `model configuration ${p.id}, pipeline ${tier('pipeline')}, answer ${tier('answer')}, embeddings ${tier('embedding')}`,
  );
}

/**
 * Embedding-space guard (frozen: REFUSE, not degrade)
 * if stored vectors were produced by a different embeddings model than the
 * active one, serving would silently mix embedding spaces — the app and worker
 * refuse to start until `npm run reindex` (which is exempt: it exists to
 * re-embed exactly those rows) has run. Extended by
 * the DIMENSION of the live collection must also agree with the active model —
 * a model-name check alone cannot see a collection left at another size.
 */
export async function assertEmbeddingSpaceConsistent(config: CogetoConfig): Promise<void> {
  if (!config.modelProviders.configured) return; // no active model → nothing can mix
  const active = config.modelProviders.tiers.embedding.model;
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  try {
    const foreign = await listForeignEmbeddingModels(createDb(pool), active);
    if (foreign.length > 0) {
      throw new Error(
        `embedding model changed: stored vectors were produced by ${foreign.join(', ')} but the ` +
          `active embeddings model is ${active}: refusing to serve mixed embedding spaces. ` +
          `Run \`docker compose exec worker npm run reindex\` ` +
          `(or restore the previous embeddings configuration), then start again.`,
      );
    }
  } finally {
    await pool.end();
  }
  const mismatch = await vectorIndexDimensionMismatch({
    url: config.qdrantUrl,
    apiKey: config.qdrantApiKey,
    embeddingModel: active,
  });
  if (mismatch) {
    throw new Error(
      `vector index dimension mismatch: the collection holds ${mismatch.actual}-dimension ` +
        `vectors but the active embeddings model ${active} produces ${mismatch.expected}. ` +
        `refusing to serve vector search against a stale index. ` +
        `Run \`docker compose exec worker npm run reindex\` (it recreates the collection at ` +
        `the correct dimension and re-embeds from Postgres), then start again.`,
    );
  }
}
