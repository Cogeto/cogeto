import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import { settleJobs, startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { withTransactionalEnqueue } from './outbox';
import { idempotentTask } from './queue';
import { writeAudit } from './audit';

describe('outbox + queue contract (integration, real Postgres)', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await startTestDatabase();
  });
  afterAll(async () => {
    await tdb.stop();
  });

  const countJobs = async (): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM graphile_worker.jobs',
    );
    return Number(rows[0]?.n ?? 0);
  };
  const countOutbox = async (sourceId: string): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM outbox_event WHERE payload->>'source_id' = $1",
      [sourceId],
    );
    return Number(rows[0]?.n ?? 0);
  };
  const countEffects = async (entityId: string): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM audit_log WHERE entity_id = $1',
      [entityId],
    );
    return Number(rows[0]?.n ?? 0);
  };
  const enqueueEcho = (sourceId: string, jobType = 'echo-test') =>
    tdb.db.transaction((tx) =>
      withTransactionalEnqueue(
        tx,
        { type: 'test.event', payload: { source_type: 'test', source_id: sourceId } },
        { type: jobType, payload: { source_type: 'test', source_id: sourceId } },
      ),
    );

  const echoTasks = (): TaskList => ({
    'echo-test': idempotentTask(tdb.db, 'echo-test', async (tx, payload) => {
      await writeAudit(tx, {
        actor: 'worker:echo-test',
        action: 'echo',
        entityType: payload.source_type,
        entityId: payload.source_id,
      });
    }),
  });

  it('transactional_enqueue: a failing transaction leaves no event and no job; a successful one leaves exactly both', async () => {
    const jobsBefore = await countJobs();

    await expect(
      tdb.db.transaction(async (tx) => {
        await withTransactionalEnqueue(
          tx,
          { type: 'test.event', payload: { source_type: 'test', source_id: 'rollback-1' } },
          { type: 'echo-test', payload: { source_type: 'test', source_id: 'rollback-1' } },
        );
        throw new Error('boom — simulated failure after enqueue');
      }),
    ).rejects.toThrow(/boom/);
    expect(await countOutbox('rollback-1')).toBe(0);
    expect(await countJobs()).toBe(jobsBefore);

    await enqueueEcho('commit-1');
    expect(await countOutbox('commit-1')).toBe(1);
    expect(await countJobs()).toBe(jobsBefore + 1);

    // Drain so later tests start from an empty queue.
    await runOnce({ pgPool: tdb.pool, taskList: echoTasks() });
  });

  it('idempotent_job: duplicate enqueue with the same key executes the effect once', async () => {
    await enqueueEcho('dup-1');
    await enqueueEcho('dup-1');
    expect(await countJobs()).toBe(2);

    await runOnce({ pgPool: tdb.pool, taskList: echoTasks() });

    expect(await countEffects('dup-1')).toBe(1);
    const { rows } = await tdb.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM job_execution WHERE source_id = 'dup-1'",
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('worker_retry: a crash mid-job retries without a duplicate effect', async () => {
    let attempts = 0;
    const tasks: TaskList = {
      'echo-test': idempotentTask(tdb.db, 'echo-test', async (tx, payload) => {
        await writeAudit(tx, {
          actor: 'worker:echo-test',
          action: 'echo',
          entityType: payload.source_type,
          entityId: payload.source_id,
        });
        attempts += 1;
        // Simulate the worker dying AFTER the effect but BEFORE commit: the
        // transaction rolls back, exactly as a killed process would leave it.
        if (attempts === 1) throw new Error('simulated worker crash');
      }),
    };

    await enqueueEcho('crash-1');
    await runOnce({ pgPool: tdb.pool, taskList: tasks }); // attempt 1 crashes; tx rolled back
    expect(await countEffects('crash-1')).toBe(0);

    // Graphile scheduled the retry with backoff; pull it to now and run again.
    // (settle first: since 0.17 the failure write can land after runOnce
    // resolves and would overwrite the pulled run_at with the backoff time)
    await settleJobs(tdb.pool);
    await tdb.pool.query('UPDATE graphile_worker._private_jobs SET run_at = now()');
    await runOnce({ pgPool: tdb.pool, taskList: tasks });

    expect(attempts).toBe(2);
    expect(await countEffects('crash-1')).toBe(1); // exactly once, no duplicate
  });

  it('dead_letter: a job that exhausts its retries is parked and visible', async () => {
    const tasks: TaskList = {
      'always-fails': idempotentTask(tdb.db, 'always-fails', async () => {
        throw new Error('this job can never succeed');
      }),
    };
    await tdb.db.transaction((tx) =>
      withTransactionalEnqueue(
        tx,
        { type: 'test.event', payload: { source_type: 'test', source_id: 'dead-1' } },
        {
          type: 'always-fails',
          payload: { source_type: 'test', source_id: 'dead-1' },
          maxAttempts: 1,
        },
      ),
    );
    await runOnce({ pgPool: tdb.pool, taskList: tasks });

    const { rows } = await tdb.pool.query(
      "SELECT job_type, error, attempts FROM dead_letter WHERE payload->>'source_id' = 'dead-1'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_type: 'always-fails', attempts: 1 });
  });
});
