import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { enqueueDelayedJob, releaseAbandonedJobLocks } from './index';

/**
 * Abandoned-lock release (issue #496): a worker killed mid-job leaves its
 * graphile lock held for the four-hour reclaim window, so the queue shows
 * one-processing-forever. Each instance runs exactly one worker, so its boot
 * may release every held lock; this proves the release and its idempotence.
 */
describe('abandoned job locks (integration, real Postgres)', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await startTestDatabase();
  });
  afterAll(async () => {
    await tdb.stop();
  });

  it('releases locks a dead worker held, and is a no-op after', async () => {
    await enqueueDelayedJob(
      tdb.db,
      { type: 'echo', payload: { source_type: 'note', source_id: 'lock-test' } },
      0,
    );
    await tdb.db.execute(sql`
      UPDATE graphile_worker._private_jobs
         SET locked_at = now() - interval '2 minutes', locked_by = 'dead-worker-id'
    `);
    expect(await releaseAbandonedJobLocks(tdb.db)).toBe(1);
    const { rows } = await tdb.db.execute(sql`
      SELECT count(*)::int AS held FROM graphile_worker._private_jobs WHERE locked_at IS NOT NULL
    `);
    expect((rows[0] as { held: number }).held).toBe(0);
    expect(await releaseAbandonedJobLocks(tdb.db)).toBe(0);
  });
});
