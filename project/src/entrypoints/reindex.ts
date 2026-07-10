import 'reflect-metadata';
import { Pool } from 'pg';
import { createDb } from '../infrastructure/index';
import { reindexMemories } from '../memory/index';
import { createModelGateway } from '../model-gateway/index';
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
    mistralApiKey: config.mistralApiKey,
    embedModel: config.mistralEmbedModel,
    redaction: redactionOptions(config),
  });

  const report = await reindexMemories({
    db,
    gateway,
    qdrantUrl: config.qdrantUrl,
    embeddingModel: config.mistralEmbedModel,
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
