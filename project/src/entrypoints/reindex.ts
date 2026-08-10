import 'reflect-metadata';
import { Pool } from 'pg';
import { createDb } from '../infrastructure/index';
import { createEmbeddingRebuild, reindexMemories } from '../memory/index';
import { assertLocalRuntimeReady, createModelGateway } from '../model-gateway/index';
import { ProviderConfigService } from '../providers/index';
import { loadConfig, redactionOptions } from './config';
import { installModelConfiguration } from './model-boot';

/**
 * reindex — the operator path over the vector index (spec §4.2; V2.4 item 7.1
 * second half). Two modes:
 *
 *   (no arguments)                 rebuild the ACTIVE collection in place from
 *                                  Postgres with the active embeddings model —
 *                                  the repair for a mismatch the boot guard
 *                                  refused (restored backup, database edit).
 *
 *   --provider <label> --model <m> move the instance to a DIFFERENT embeddings
 *                                  model from the shell: the same managed
 *                                  rebuild the interface runs (new collection
 *                                  beside the serving one, switch only on
 *                                  verified completion), driven in-process so
 *                                  it works while the app and worker refuse to
 *                                  start. Shares the engine, not a copy of it.
 *
 * Run inside the stack: `cogeto reindex [...]`, or directly
 * `docker compose run --rm worker npm run reindex [-- --provider X --model Y]`.
 * `compose run` rather than `exec`, so it works while the services crash-loop.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  // The DATABASE's model configuration is what this instance runs (V2.4 item
  // 7.1): seeded once from the environment, authoritative after that. A tool
  // that resolved the environment instead could embed with a model the
  // instance replaced, which is precisely the mixed embedding space the boot
  // guard exists to refuse.
  const live = await installModelConfiguration(config);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = createDb(pool);

  try {
    if (args.model) {
      await switchModel(config, db, live, args as { provider?: string; model: string });
      return;
    }

    // Redaction wraps embeddings too: a reindex under redaction
    // must re-embed pseudonymized text, matching how the vectors were first made.
    const gateway = createModelGateway({
      providers: config.modelProviders,
      redaction: redactionOptions(config),
    });
    // About to issue the full corpus's embedding calls — probe the local runtime
    // first so a down runtime or missing model fails before any work (0041 r2).
    await assertLocalRuntimeReady(config.modelProviders);

    const report = await reindexMemories({
      db,
      gateway,
      qdrantUrl: config.qdrantUrl,
      qdrantApiKey: config.qdrantApiKey,
      embeddingModel: config.modelProviders.tiers.embedding.model,
      log: (message) => console.log(`reindex: ${message}`),
    });

    console.log('reindex report:');
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      console.error(
        `reindex FAILED verification: ${report.pointCount} points vs ${report.embeddable} embeddable memories`,
      );
      process.exit(1);
    }
    console.log('reindex OK, point count matches embeddable memories');
  } finally {
    await pool.end();
  }
}

/**
 * The managed switch, driven from the shell. Identical machinery to the
 * interface: the ProviderConfigService resolves and probes the target and
 * supplies the switch port; the memory engine owns the state row, the target
 * collection, and the one-transaction switch. If a worker is alive its
 * advance job may do slices of the work — the single-flight lock makes that
 * cooperation, not a conflict.
 */
async function switchModel(
  config: ReturnType<typeof loadConfig>,
  db: ReturnType<typeof createDb>,
  live: Awaited<ReturnType<typeof installModelConfiguration>>,
  args: { provider?: string; model: string },
): Promise<void> {
  const service = new ProviderConfigService(db, {
    live,
    masterKey: config.masterKey,
    redacted: config.redactionEnabled,
    reasoningHeadroom: config.modelProviders.reasoningHeadroom,
    timeoutsMs: config.modelProviders.timeoutsMs,
    trustScoresDir: config.trustScoresDir,
    pollIntervalMs: 0,
  });

  const providers = await service.listProviders();
  const provider = args.provider
    ? providers.find((row) => row.label === args.provider)
    : providers.find((row) => row.assignedTiers.includes('embeddings'));
  if (!provider) {
    console.error(
      args.provider
        ? `no provider labelled "${args.provider}". Providers: ${providers.map((p) => p.label).join(', ')}`
        : 'no provider holds the embeddings tier; name one with --provider <label>',
    );
    process.exit(1);
    return;
  }
  if (!provider.supportsEmbeddings) {
    console.error(`provider "${provider.label}" (${provider.type}) has no embeddings API`);
    process.exit(1);
    return;
  }

  console.log(`probing ${provider.label} / ${args.model} ...`);
  const probe = await service.probeEmbeddingsModel(provider.id, args.model);
  if (!probe.ok || !probe.dimensions) {
    console.error(`probe failed: ${probe.error ?? 'no vector returned'} (${probe.reason ?? '?'})`);
    process.exit(1);
    return;
  }
  console.log(`probe ok: ${probe.dimensions}-dimension vectors, ${probe.latencyMs ?? '?'} ms`);

  const rebuild = createEmbeddingRebuild({
    db,
    qdrant: {
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
      embeddingModel: config.modelProviders.tiers.embedding.model,
    },
  });

  const existing = await rebuild.status();
  if (existing) {
    console.log(
      `adopting the existing rebuild to ${existing.targetModel} ` +
        `(${existing.factsDone}/${existing.factsTotal})`,
    );
  } else {
    await rebuild.begin({
      target: {
        providerId: provider.id,
        providerLabel: provider.label,
        model: args.model,
        dimensions: probe.dimensions,
      },
      requestedBy: 'operator',
    });
    console.log(`rebuild started: ${provider.label} / ${args.model}`);
  }

  const passDeps = {
    gatewayFor: async (target: { providerId: string; model: string }) =>
      createModelGateway({
        providers: await service.embeddingRunProvidersFor(target.providerId, target.model),
        redaction: redactionOptions(config),
      }),
    switchPort: service.embeddingsSwitchPort(),
    log: (message: string) => console.log(`reindex: ${message}`),
  };

  for (;;) {
    const { ran, outcome } = await rebuild.runPass(passDeps);
    if (!ran) {
      // A live worker holds the single-flight lock and is advancing the same
      // rebuild; watch its progress instead of duplicating it.
      await sleep(2_000);
    } else if (outcome === 'completed') {
      console.log('reindex OK: rebuild complete, embeddings assignment switched');
      return;
    } else if (outcome === 'failed') {
      const status = await rebuild.status();
      console.error(`rebuild parked as failed: ${status?.error ?? 'unknown'}`);
      console.error('re-run this command to resume, or cancel it from the interface');
      process.exit(1);
      return;
    } else if (outcome === 'cancelled') {
      console.log('rebuild cancelled; the previous configuration is untouched');
      return;
    } else if (outcome === 'paused_budget') {
      console.error('daily model budget exhausted; the rebuild resumes automatically later');
      process.exit(1);
      return;
    } else if (outcome === 'idle' || outcome === 'retired') {
      const status = await rebuild.status();
      if (!status) {
        console.log('reindex OK: rebuild complete, embeddings assignment switched');
        return;
      }
      await sleep(2_000);
    }
    const status = await rebuild.status();
    if (status) {
      console.log(
        `progress ${status.factsDone}/${status.factsTotal}` +
          (status.estimatedSecondsRemaining !== null
            ? ` (~${status.estimatedSecondsRemaining}s remaining)`
            : ''),
      );
    }
  }
}

function parseArgs(argv: string[]): { provider?: string; model?: string } {
  const out: { provider?: string; model?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--provider' && argv[i + 1]) out.provider = argv[++i];
    else if (argv[i] === '--model' && argv[i + 1]) out.model = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      console.error('usage: reindex [--provider <label>] [--model <model>]');
      process.exit(2);
    }
  }
  if (out.provider && !out.model) {
    console.error('--provider needs --model: the target embeddings model to move to');
    process.exit(2);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error('reindex failed:', error);
  process.exit(1);
});
