import { Client } from 'pg';

/**
 * migrate — one-shot init container (§A.2: migrations never run on app boot).
 *
 * S1-A baseline: establishes the migration ledger and applies nothing.
 * Migration 0001 (the contractual core, decision 0003 ruling 1) lands in S1-B
 * as reviewable SQL applied by this runner.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.COGETO_DATABASE_URL;
  if (!databaseUrl) throw new Error('COGETO_DATABASE_URL is required');

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS cogeto_migrations (
        id          integer PRIMARY KEY,
        name        text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM cogeto_migrations',
    );
    console.log(
      `migration ledger ready; ${rows[0]?.count ?? '0'} applied, 0 pending (S1-A baseline)`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('migrate failed:', error);
  process.exit(1);
});
