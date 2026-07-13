import { copyFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { Pool } from 'pg';
import { applyMigrations, ensureInstanceKeys, PUBLIC_KEY_FILE } from '../infrastructure/index';

/**
 * migrate — one-shot init container (§A.2: migrations never run on app boot).
 * Applies pending reviewable SQL migrations (0001 contractual core, 0002
 * infrastructure — decision 0003 ruling 1) and the Graphile Worker schema,
 * and generates the instance signing keypair on first boot (§B.1, decision
 * 0008 — this job is the only writer of the instance-keys volume).
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.COGETO_DATABASE_URL;
  if (!databaseUrl) throw new Error('COGETO_DATABASE_URL is required');

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await applyMigrations(pool);
    console.log(
      `migrations: ${result.applied.length} applied now [${result.applied.join(', ') || 'none'}], ` +
        `${result.total} total on record; graphile_worker schema up to date`,
    );
    const instanceKeyDir = process.env.COGETO_INSTANCE_KEY_DIR ?? '.instance-keys';
    await ensureInstanceKeys(instanceKeyDir);
    console.log(`instance signing keypair ready in ${instanceKeyDir}`);

    // QS-9: publish ONLY the public half into the app-facing volume, so the
    // internet-facing app never mounts the receipt-signing private key.
    const pubkeyDir = process.env.COGETO_INSTANCE_PUBKEY_DIR;
    if (pubkeyDir && pubkeyDir !== instanceKeyDir) {
      await mkdir(pubkeyDir, { recursive: true });
      await copyFile(
        path.join(instanceKeyDir, PUBLIC_KEY_FILE),
        path.join(pubkeyDir, PUBLIC_KEY_FILE),
      );
      console.log(`instance public key published to ${pubkeyDir} (app mounts this — QS-9)`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('migrate failed:', error);
  process.exit(1);
});
