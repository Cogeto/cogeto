import { Pool } from 'pg';
import { createDb } from '../infrastructure/index';
import { createIntegritySweep } from '../memory/index';
import { WebSourceDeletion } from '../research/index';
import { EmailSourceDeletion } from '../email/index';
import { NotesSourceDeletion } from '../notes/index';
import { ChatSourceDeletion, ConversationSourceDeletion } from '../chat/index';
import { loadConfig } from './config';
import { installModelConfiguration } from './model-boot';

/**
 * sweep — the on-demand integrity sweep (spec §11.1 step 4). The same check the
 * worker runs nightly via cron, runnable any time
 *
 *   npm run sweep                                    (local / published ports)
 *   docker compose exec worker node project/src/dist/entrypoints/sweep.js
 *
 * Exit code 1 when any integrity alert is on record or the chain is broken —
 * scriptable as a monitoring probe. Ships in the runtime image (an ops tool,
 * not a dev fixture).
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
    const sweep = createIntegritySweep({
      db: createDb(pool),
      qdrant: {
        url: config.qdrantUrl,
        apiKey: config.qdrantApiKey,
        embeddingModel: config.modelProviders.tiers.embedding.model,
      },
      s3: {
        url: config.s3Url,
        accessKey: config.s3AccessKey,
        secretKey: config.s3SecretKey,
        bucket: config.s3Bucket,
      },
      instanceKeyDir: config.instanceKeyDir,
      // The orphan-memory arm's source-row probes — the same
      // adapters the composition roots bind to the deletion saga.
      sourceDeletions: [
        new NotesSourceDeletion(),
        new ChatSourceDeletion(),
        new ConversationSourceDeletion(),
        new EmailSourceDeletion(),
        new WebSourceDeletion(),
      ],
    });
    const report = await sweep.run();
    console.log(
      `sweep: ${report.receiptsChecked} receipt(s), ${report.identifiersChecked} identifier(s) checked; ` +
        `${report.objectsScanned} object(s) scanned, ${report.payloadsChecked} payload(s) compared ` +
        `(${report.payloadsHealed} healed); ` +
        `${report.newAlerts} new alert(s), ${report.openAlerts} on record; ` +
        `chain ${report.chainOk ? 'ok' : `BROKEN (${report.chainError})`}`,
    );
    if (report.openAlerts > 0 || !report.chainOk) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('sweep failed:', error);
  process.exit(1);
});
