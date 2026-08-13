import { Pool } from 'pg';
import type { Logger } from 'pino';
import { createDb } from '../infrastructure/index';
import { checkEmbeddingSpace } from '../memory/index';
import { LiveModelConfiguration } from '../model-gateway/index';
import type { ResolvedModelProviders } from '../model-gateway/index';
import { loadModelConfiguration } from '../providers/index';
import type { CogetoConfig } from './config';

/**
 * Put the DATABASE's model configuration in force (V2.4 item 7.1).
 *
 * Called by every process that talks to a model, before anything is built. It
 * replaces `config.modelProviders` (the boot placeholder, which carries only
 * the environment's runtime knobs) with what the instance actually runs, so
 * every consumer downstream — the gateway, the embedding guard, the capability
 * registry, the reports, the boot log — reads one object and cannot disagree.
 *
 * The returned holder is the same object: it is what lets a saved assignment
 * reach a running process without a restart.
 *
 * A process that cannot reach the database does not start, which is already
 * true of every process here for other reasons; there is deliberately no
 * "fall back to the environment" path, because the environment holds no model
 * configuration at all: providers are configured in the interface, and an
 * instance with none boots cleanly with model features off.
 */
export async function installModelConfiguration(
  config: CogetoConfig,
  logger?: Logger,
): Promise<LiveModelConfiguration> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  try {
    const providers = await loadModelConfiguration(createDb(pool), {
      masterKey: config.masterKey,
      redacted: config.redactionEnabled,
      reasoningHeadroom: config.modelProviders.reasoningHeadroom,
      timeoutsMs: config.modelProviders.timeoutsMs,
      // An unreadable provider key is reported here, at boot, so the reason
      // model features are off is in the log and never a silent mystery.
      logger: logger ? { error: (message: string) => logger.error(message) } : undefined,
    });
    const live = new LiveModelConfiguration(providers);
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
      'no model provider is configured. The instance runs, but capture, ingestion and chat ' +
        'are off until an administrator adds a provider and assigns the tiers under Providers ' +
        'in the interface. This is the normal first-run state, not an error.',
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
 * Embedding-space guard (frozen: REFUSE, not degrade). Since the managed
 * rebuild (V2.4 item 7.1 second half) NO interface action can produce the
 * state this refuses: the pending model lives beside the active one, and the
 * switch stamps rows, flips the assignment and retargets the index in one
 * transaction. The guard stays as the NET for states produced by other means
 * — a direct database edit, a restored backup whose index and configuration
 * disagree — and its message states exactly what mismatched, what the active
 * and index configurations are, and the command that repairs it.
 */
export async function assertEmbeddingSpaceConsistent(config: CogetoConfig): Promise<void> {
  if (!config.modelProviders.configured) return; // no active model → nothing can mix
  const active = config.modelProviders.tiers.embedding.model;
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
  try {
    const problem = await checkEmbeddingSpace(createDb(pool), {
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
      activeModel: active,
    });
    if (!problem) return;
    const repair =
      `Repair from the shell: \`cogeto reindex\` (or ` +
      `\`docker compose run --rm worker npm run reindex\`) re-embeds every stored ` +
      `memory with the active model; add \`--provider <label> --model <model>\` to ` +
      `move to a different embeddings model instead. Restoring the previous ` +
      `embeddings configuration also resolves it.`;
    if (problem.kind === 'foreign_models') {
      const stamped = (problem.foreign ?? [])
        .map((entry) => `${entry.model} (${entry.rows} memories)`)
        .join(', ');
      throw new Error(
        `embedding space mismatch: stored vectors were produced by ${stamped}, but the active ` +
          `embeddings model is ${active} (collection "${problem.activeCollection}"). ` +
          `Serving would silently mix embedding spaces, so this process refuses to start. ` +
          `This state is not reachable from the interface; it usually means a restored backup ` +
          `or a direct database edit. ${repair}`,
      );
    }
    throw new Error(
      `vector index dimension mismatch: collection "${problem.activeCollection}" holds ` +
        `${problem.actual}-dimension vectors, but the active embeddings model ${active} ` +
        `produces ${problem.expected}. Refusing to serve vector search against a stale index. ` +
        `This state is not reachable from the interface; it usually means a restored backup ` +
        `or a direct database edit. ${repair}`,
    );
  } finally {
    await pool.end();
  }
}
