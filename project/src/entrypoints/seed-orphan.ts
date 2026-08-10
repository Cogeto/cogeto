import { Pool } from 'pg';
import { createDb } from '../infrastructure/index';
import { seedOrphanPoint } from '../memory/index';
import { loadConfig } from './config';
import { installModelConfiguration } from './model-boot';

/**
 * seed:orphan — DEV-ONLY (excluded from production images, see the Dockerfile
 * runtime stage). Plants a stray Qdrant point matching an identifier a
 * confirmed receipt promised gone, so the sweep's alert path is demonstrable
 *
 *   docker compose --profile dev-seed run --rm seed-orphan
 *   ...then run the sweep and watch integrity_alert + System go red.
 *
 * Requires at least one confirmed deletion receipt (delete something first).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  // The DATABASE's model configuration is what this instance runs (V2.4 item
  // 7.1): seeded once from the environment, authoritative after that. A tool
  // that resolved the environment instead could embed with a model the
  // instance replaced, which is precisely the mixed embedding space the boot
  // guard exists to refuse.
  await installModelConfiguration(config);
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const planted = await seedOrphanPoint({
      db: createDb(pool),
      qdrant: {
        url: config.qdrantUrl,
        apiKey: config.qdrantApiKey,
        embeddingModel: config.modelProviders.tiers.embedding.model,
      },
    });
    if (!planted) {
      console.error('no confirmed receipt with enumerated points found, delete a source first');
      process.exit(1);
    }
    console.log('planted an orphan Qdrant point for the sweep drill:');
    console.log(`  receipt id : ${planted.receiptId}`);
    console.log(`  point id   : ${planted.pointId}`);
    console.log('run the sweep to see the integrity alert:');
    console.log('  docker compose exec worker node project/src/dist/entrypoints/sweep.js');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('seed:orphan failed:', error);
  process.exit(1);
});
