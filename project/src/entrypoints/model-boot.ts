import { Pool } from 'pg';
import type { Logger } from 'pino';
import { createDb } from '../infrastructure/index';
import { listForeignEmbeddingModels } from '../memory/index';
import type { CogetoConfig } from './config';

/**
 * Model-configuration boot surface (decision 0040 ruling 3): every boot states
 * the ACTIVE configuration id and per-tier bindings loudly — changing the
 * configuration mid-life is supported, the id changes, and the boot log states
 * it. Never logs keys.
 */
export function logModelConfiguration(logger: Logger, config: CogetoConfig): void {
  const p = config.modelProviders;
  if (!p.configured) {
    logger.warn(
      { configuration: 'unconfigured' },
      'model gateway not configured — model features disabled until a provider key is set',
    );
    return;
  }
  const tier = (t: 'pipeline' | 'answer' | 'embedding'): string =>
    `${p.tiers[t].provider}/${p.tiers[t].model}`;
  logger.info(
    {
      configuration: p.id,
      pipeline: tier('pipeline'),
      answer: tier('answer'),
      embeddings: tier('embedding'),
    },
    `model configuration ${p.id} — pipeline ${tier('pipeline')}, answer ${tier('answer')}, embeddings ${tier('embedding')}`,
  );
}

/**
 * Embedding-space guard (decision 0040 ruling 3, frozen: REFUSE, not degrade):
 * if stored vectors were produced by a different embeddings model than the
 * active one, serving would silently mix embedding spaces — the app and worker
 * refuse to start until `npm run reindex` (which is exempt: it exists to
 * re-embed exactly those rows) has run.
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
          `active embeddings model is ${active} — refusing to serve mixed embedding spaces ` +
          `(decision 0040 ruling 3). Run \`docker compose exec worker npm run reindex\` ` +
          `(or restore the previous embeddings configuration), then start again.`,
      );
    }
  } finally {
    await pool.end();
  }
}
