import 'reflect-metadata';
import { Pool } from 'pg';
import type { Principal } from '@cogeto/shared';
import { createDb } from '../infrastructure/index';
import { createMemoryStore } from '../memory/index';
import { createModelGateway } from '../model-gateway/index';
import { loadConfig, redactionOptions } from './config';

/**
 * vector:smoke — ops check for the semantic search primitive. Embeds the query
 * through the gateway and runs MemoryStore.vectorSearch as the given (or the
 * most recent) owner, printing scores and the owner's own visible content.
 *
 *   docker compose exec app npm run vector:smoke -- "budget proposal" [userId]
 */
async function main(): Promise<void> {
  const query = process.argv[2];
  if (!query) {
    console.error('usage: npm run vector:smoke -- "<query text>" [userId]');
    process.exit(2);
  }
  const config = loadConfig();
  if (!config.mistralApiKey) {
    console.error('vector:smoke needs COGETO_MISTRAL_API_KEY to embed the query');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  const store = createMemoryStore({
    db: createDb(pool),
    qdrant: {
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
      embeddingModel: config.mistralEmbedModel,
    },
  });

  // Smoke tool only: default to the most recent memory's owner.
  const userId =
    process.argv[3] ??
    (
      await pool.query<{ owner_id: string }>(
        'SELECT owner_id FROM memory ORDER BY created_at DESC LIMIT 1',
      )
    ).rows[0]?.owner_id;
  if (!userId) {
    console.error('no memories exist yet — capture a note first');
    process.exit(2);
  }
  const principal: Principal = {
    userId,
    name: 'vector-smoke',
    email: null,
    orgId: 'smoke',
    orgName: 'smoke',
    roles: [],
  };

  const gateway = createModelGateway({
    mistralApiKey: config.mistralApiKey,
    embedModel: config.mistralEmbedModel,
    redaction: redactionOptions(config),
  });
  const [embedding] = await gateway.embed([query]);
  const hits = await store.vectorSearch(principal, embedding!, { topK: 5 });

  console.log(`query: "${query}" (as owner ${userId})`);
  if (hits.length === 0) console.log('no hits');
  for (const hit of hits) {
    const row = await store.getForPrincipal(principal, hit.memoryId);
    console.log(
      `  ${hit.score.toFixed(3)}  ${hit.memoryId}  ` +
        (row ? `[${row.status}] ${row.content}` : '(not visible through the gates)'),
    );
  }
  await pool.end();
}

main().catch((error: unknown) => {
  console.error('vector:smoke failed:', error);
  process.exit(1);
});
