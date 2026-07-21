import { Pool } from 'pg';
import { createDb } from '../infrastructure/index';
import { createMemoryReconciliation } from '../memory/index';
import { DreamingService, ReconciliationService } from '../ingestion/index';
import { createModelGateway } from '../model-gateway/index';
import { loadConfig, redactionOptions } from './config';

/**
 * dream — the on-demand dreaming cycle (§B.6 plain form; decision 0011). The
 * same four passes the worker runs nightly at 03:30, runnable any time:
 *
 *   npm run dream                                    (local / published ports)
 *   docker compose exec worker node project/src/dist/entrypoints/dream.js
 *
 * Needs the Mistral key (the batch dedup/contradiction passes are model
 * confirmations); the staleness and dormant passes are model-free.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.modelProviders.configured) {
    console.error('dream needs MISTRAL_API_KEY — the reconcile passes are model confirmations');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const db = createDb(pool);
    const gateway = createModelGateway({
      providers: config.modelProviders,
      redaction: redactionOptions(config),
    });
    const { store, reconciliation } = createMemoryReconciliation({
      db,
      qdrant: {
        url: config.qdrantUrl,
        apiKey: config.qdrantApiKey,
        embeddingModel: config.modelProviders.tiers.embedding.model,
      },
    });
    const dreaming = new DreamingService(
      db,
      store,
      new ReconciliationService(gateway, store, reconciliation),
    );
    const report = await dreaming.run((event, message) => console.log(`  ${message}`, event));
    console.log(
      `dream: run ${report.runId} [${report.scopeFrom} → ${report.scopeTo}] — ` +
        `${report.considered} fact(s) considered across ${report.ownersProcessed} owner(s); ` +
        `${report.merged} merged (${report.enriched} enriched), ${report.contradictions} conflict(s), ` +
        `${report.superseded} superseded, ${report.outdated} outdated, ` +
        `${report.dormantFlagged} gone quiet, ${report.flagsCleared} flag(s) cleared`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('dream failed:', error);
  process.exit(1);
});
