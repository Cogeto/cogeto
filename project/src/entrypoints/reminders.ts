import { Pool } from 'pg';
import { createDb } from '../infrastructure/index';
import { createMemoryStore } from '../memory/index';
import { createModelGateway } from '../model-gateway/index';
import { TasksEngine } from '../tasks/index';
import { loadConfig, redactionOptions } from './config';

/**
 * reminders — the on-demand task reminders pass (F3 handoff §2). The SAME pass
 * the worker runs nightly at 03:40 (one crontab line in the graphile runner —
 * NOT a second scheduler), runnable any time for a demo or a manual sweep:
 *
 *   npm run reminders                                     (local / published ports)
 *   docker compose exec worker node project/src/dist/entrypoints/reminders.js
 *
 * Model-free: it only stamps/clears the additive reminder columns on `task`.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const db = createDb(pool);
    // The pass never calls the model; the gateway is only a constructor dep, so
    // a missing key is fine here (unlike `dream`, which does confirm with it).
    const gateway = createModelGateway({
      mistralApiKey: config.mistralApiKey,
      pipelineModel: config.mistralPipelineModel,
      answerModel: config.mistralAnswerModel,
      embedModel: config.mistralEmbedModel,
      redaction: redactionOptions(config),
    });
    const store = createMemoryStore({
      db,
      qdrant: { url: config.qdrantUrl, embeddingModel: config.mistralEmbedModel },
    });
    const engine = new TasksEngine(db, store, gateway);
    const report = await engine.runReminders((message) => console.log(`  ${message}`));
    console.log(
      `reminders: ${report.dueRaised} due raised, ` +
        `${report.dormantRaised} dormant raised, ${report.dormantCleared} cleared`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('reminders failed:', error);
  process.exit(1);
});
