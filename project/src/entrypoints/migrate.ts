import { Pool } from 'pg';
import { applyMigrations } from '../infrastructure/index';

/**
 * migrate — one-shot init container (§A.2: migrations never run on app boot).
 * Applies pending reviewable SQL migrations (0001 contractual core, 0002
 * infrastructure — decision 0003 ruling 1) and the Graphile Worker schema.
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
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('migrate failed:', error);
  process.exit(1);
});
