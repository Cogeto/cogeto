import 'reflect-metadata';
import { Pool } from 'pg';
import { createDb } from '../infrastructure/index';
import { reindexMemories } from '../memory/index';
import { assertLocalRuntimeReady, createModelGateway } from '../model-gateway/index';
import { loadConfig, redactionOptions } from './config';

/**
 * reindex — rebuilds the Qdrant index from Postgres (§A.4; memory README).
 * Run inside the stack: `docker compose exec app npm run reindex` (or worker).
 * Exits nonzero when the final point count does not match the embeddable rows.
 * Without an API key it still runs, but fails if any row needs re-embedding.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = createDb(pool);
  // Redaction wraps embeddings too (decision 0023): a reindex under redaction
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
  await pool.end();

  console.log('reindex report:');
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    console.error(
      `reindex FAILED verification: ${report.pointCount} points vs ${report.embeddable} embeddable memories`,
    );
    process.exit(1);
  }
  console.log('reindex OK — point count matches embeddable memories');
}

main().catch((error: unknown) => {
  console.error('reindex failed:', error);
  process.exit(1);
});
