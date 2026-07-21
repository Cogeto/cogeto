import { Pool } from 'pg';
import { assertDemoAllowed, loadConfig, redactionOptions } from './config';
import { createDb } from '../infrastructure/index';
import { MemoryObjectStore } from '../memory/index';
import { createModelGateway } from '../model-gateway/index';
import { establishDemoSession } from './demo/bootstrap';
import { credentialsBanner, ensureDemoCredentials } from './demo/credentials';
import { resetDemoWorld } from './demo/reset';
import { summarize } from './demo/assertions';

/**
 * demo:reset — DEV/DEMO-ONLY. Tears down all demo data and re-seeds through the
 * pipeline (decision 0022 ruling 2). The demo Principal + token are preserved,
 * so an open browser tab keeps working. The scheduled reset (worker cron, demo
 * profile only) runs the same `resetDemoWorld` routine.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  assertDemoAllowed(config);
  if (!config.modelProviders.configured) {
    console.error(
      'demo:reset needs MISTRAL_API_KEY (re-seeding runs the real extraction pipeline)',
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const db = createDb(pool);
    const { api, ownerId, principal } = await establishDemoSession(config);
    console.log(`resetting demo for ${principal.name} (${ownerId})…`);

    const gateway = createModelGateway({
      providers: config.modelProviders,
      redaction: redactionOptions(config),
    });
    const objects = new MemoryObjectStore({
      url: config.s3Url,
      accessKey: config.s3AccessKey,
      secretKey: config.s3SecretKey,
      bucket: config.s3Bucket,
    });

    const state = await resetDemoWorld({
      pool,
      db,
      api,
      ownerId,
      objects,
      gateway,
      qdrantUrl: config.qdrantUrl,
      qdrantApiKey: config.qdrantApiKey,
      embeddingModel: config.modelProviders.tiers.embedding.model,
      strict: true,
      log: (m) => console.log(m),
    });
    console.log(`demo sandbox reset: ${summarize(state)}`);
    // A reset is a fresh world → rotate the login password (decision 0027).
    const creds = await ensureDemoCredentials(config.demoSessionFile, { rotate: true });
    console.log(credentialsBanner(creds));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('demo:reset failed:', error);
  process.exit(1);
});
