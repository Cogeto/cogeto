import { Pool } from 'pg';
import { assertDemoAllowed, loadConfig } from './config';
import { establishDemoSession } from './demo/bootstrap';
import { alreadySeeded, seedDemoWorld } from './demo/seed';
import { inspectEndState, summarize } from './demo/assertions';

/**
 * demo:seed — DEV/DEMO-ONLY (excluded from production images). Provisions the
 * demo Principal, feeds the Ana sandbox corpus through the REAL public HTTP API,
 * runs one dreaming cycle, and asserts the end state, failing loudly if the
 * fictional world did not materialize as designed (decision 0022, §B.9).
 *
 * Idempotent: a re-run on an already-seeded instance verifies the state and
 * exits rather than duplicating the corpus. `npm run demo:reset` re-seeds fresh.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  assertDemoAllowed(config); // refuses on a production instance / without demo mode

  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const { api, ownerId, principal } = await establishDemoSession(config);
    console.log(`demo Principal ready: ${principal.name} (${ownerId})`);

    if (await alreadySeeded(pool, ownerId)) {
      const state = await inspectEndState(pool, ownerId);
      console.log(`demo already seeded — ${summarize(state)}`);
      if (state.hardFailures.length > 0) {
        console.error('WARNING: an already-seeded instance does not satisfy assertions:');
        for (const f of state.hardFailures) console.error(`  ✗ ${f}`);
        console.error('run `npm run demo:reset` to rebuild it.');
        process.exitCode = 1;
      }
      return;
    }

    const state = await seedDemoWorld({
      api,
      pool,
      ownerId,
      strict: true,
      log: (m) => console.log(m),
    });
    console.log(`demo sandbox seeded: ${summarize(state)}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('demo:seed failed:', error);
  process.exit(1);
});
