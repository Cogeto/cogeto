import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { Task, TaskList } from 'graphile-worker';
import { settleJobs, startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import {
  currentUsageUserId,
  DailyModelBudget,
  PostgresDailyCounters,
  runWithUsageContext,
  setUsageUser,
  withTransactionalEnqueue,
} from '../infrastructure/index';
import { attributedTask } from './worker-tasks';

/**
 * Worker model metering (security audit 2.0 SEC-10).
 *
 * The finding: worker model traffic was entirely unmetered. This composition
 * root registered the gateway WITHOUT the budget wrapper, and the wrapper
 * no-ops with no user in the usage scope — so extraction, verification,
 * embedding, dreaming, skill advance and research conclusion ran with no daily
 * ceiling at all, driven by anything a user could enqueue.
 *
 * The fix has two halves, and both are asserted here: the enqueuing principal
 * travels in the job payload, and the worker's task wrapper turns it back into
 * a usage scope. The payload change is ADDITIVE — a job enqueued under the old
 * shape must still run, unattributed.
 */
describe('worker model metering (integration, real Postgres)', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await startTestDatabase();
  });
  afterAll(async () => {
    await tdb.stop();
  });
  beforeEach(async () => {
    await tdb.pool.query('TRUNCATE usage_counter');
  });

  const at = (iso: string) => () => new Date(iso);

  it('carries the enqueuing principal into the payload and opens a usage scope in the worker', async () => {
    // The app side: an enqueue made inside a principal's usage scope stamps
    // the payload additively.
    await runWithUsageContext(async () => {
      setUsageUser('user-enqueuer');
      await tdb.db.transaction((tx) =>
        withTransactionalEnqueue(
          tx,
          { type: 'test.event', payload: { source_type: 'test', source_id: 'src-1' } },
          { type: 'metered-test', payload: { source_type: 'test', source_id: 'src-1' } },
        ),
      );
    });
    const { rows } = await tdb.pool.query<{ payload: { principal_id?: string } }>(
      `SELECT payload FROM graphile_worker._private_jobs
        WHERE payload->>'source_id' = 'src-1'`,
    );
    expect(rows[0]?.payload.principal_id).toBe('user-enqueuer');

    // The worker side: the wrapper turns it back into a usage scope, which
    // is what makes the budget decorator meter pipeline model calls at all.
    const seen: (string | undefined)[] = [];
    const observe: Task = () => {
      seen.push(currentUsageUserId());
      return Promise.resolve();
    };
    const tasks: TaskList = { 'metered-test': attributedTask('metered-test', observe) };
    await runOnce({ pgPool: tdb.pool, taskList: tasks });
    await settleJobs(tdb.pool);
    expect(seen).toEqual(['user-enqueuer']);
  });

  it('tolerates a payload with no principal — the pre-change shape still runs, unattributed', async () => {
    await tdb.pool.query(`SELECT graphile_worker.add_job('legacy-test', payload := $1::json)`, [
      JSON.stringify({ source_type: 'test', source_id: 'src-legacy' }),
    ]);
    const seen: (string | undefined)[] = [];
    const observe: Task = () => {
      seen.push(currentUsageUserId());
      return Promise.resolve();
    };
    await runOnce({
      pgPool: tdb.pool,
      taskList: { 'legacy-test': attributedTask('legacy-test', observe) },
    });
    await settleJobs(tdb.pool);
    expect(seen).toEqual([undefined]);
  });

  it('a metered worker call is charged to the enqueuing principal, on the same total as the app', async () => {
    const counters = new PostgresDailyCounters(tdb.db, at('2026-07-30T10:00:00Z'));
    const appBudget = new DailyModelBudget({ dailyCalls: 4, dailyTokens: 1_000_000 }, counters);
    // Two calls charged by the app process …
    await runWithUsageContext(async () => {
      setUsageUser('user-a');
      await appBudget.record('user-a', 10, 'chat');
      await appBudget.record('user-a', 10, 'chat');
    });
    // … and two by the worker, under the scope its task wrapper opened.
    const workerBudget = new DailyModelBudget({ dailyCalls: 4, dailyTokens: 1_000_000 }, counters);
    await runWithUsageContext(async () => {
      setUsageUser('user-a');
      expect(await workerBudget.hasBudget('user-a')).toBe(true);
      await workerBudget.record('user-a', 10, 'ingestion');
      await workerBudget.record('user-a', 10, 'ingestion');
    });
    // One shared ceiling, reached by the two processes together — which is
    // exactly what an unmetered worker made impossible.
    expect(await workerBudget.hasBudget('user-a')).toBe(false);
    expect(await appBudget.hasBudget('user-a')).toBe(false);
  });
});
