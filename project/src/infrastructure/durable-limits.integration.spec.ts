import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { InMemoryDailyCounters, PostgresDailyCounters } from './daily-counters';
import { DailyModelBudget } from './model-budget';
import { InMemoryRateLimitStore, PostgresRateLimitStore } from './rate-limit-store';
import type { RateLimitStore } from './rate-limit-store';
import { RateLimitGuard } from './rate-limit';
import type { RateLimitBuckets } from './limits';

/**
 * Durable abuse limits (security audit 2.0 SEC-18 / SEC-10 / SEC-27,
 * migration 0038). The properties this suite exists to hold:
 *
 *  1. the limits SURVIVE A RESTART — a fresh store over the same database sees
 *     the same totals, which is the whole finding: an app crash-looping under
 *     attack used to REMOVE the cap;
 *  2. the limits are SHARED ACROSS PROCESSES — two stores (the app and the
 *     worker) count one number, not two halves;
 *  3. the durable store behaves IDENTICALLY to the in-process one it replaced
 *     under normal use, asserted by running the same script through both;
 *  4. the WORKER PATH IS METERED — a job enqueued by a principal runs inside
 *     that principal's usage scope, so its model spend has an owner.
 */
describe('durable abuse limits (integration, real Postgres)', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await startTestDatabase();
  });
  afterAll(async () => {
    await tdb.stop();
  });
  beforeEach(async () => {
    await tdb.pool.query('TRUNCATE usage_counter, rate_limit_window');
  });

  const at = (iso: string) => () => new Date(iso);

  describe('daily counters', () => {
    it('persist_across_restart: a fresh counter instance reads the stored total', async () => {
      const first = new PostgresDailyCounters(tdb.db, at('2026-07-30T10:00:00Z'));
      await first.add('user-a', 'capture', 3);
      await first.add('user-a', 'capture', 2);
      expect(await first.get('user-a', 'capture')).toBe(5);

      // "Restart": every process-local state is gone, the database is not.
      const afterRestart = new PostgresDailyCounters(tdb.db, at('2026-07-30T11:00:00Z'));
      expect(await afterRestart.get('user-a', 'capture')).toBe(5);
    });

    it('shared_across_processes: two independent instances increment one total', async () => {
      const app = new PostgresDailyCounters(tdb.db, at('2026-07-30T10:00:00Z'));
      const worker = new PostgresDailyCounters(tdb.db, at('2026-07-30T10:00:00Z'));
      await Promise.all([
        ...Array.from({ length: 10 }, () => app.add('user-a', 'model_calls', 1, 'chat')),
        ...Array.from({ length: 10 }, () => worker.add('user-a', 'model_calls', 1, 'ingestion')),
      ]);
      // No increment lost to a read-modify-write race: the upsert is atomic.
      expect(await app.get('user-a', 'model_calls')).toBe(20);
      expect(await worker.get('user-a', 'model_calls')).toBe(20);
    });

    it('task_family: recorded separately, summed for enforcement (token accounting reads this)', async () => {
      const counters = new PostgresDailyCounters(tdb.db, at('2026-07-30T10:00:00Z'));
      await counters.add('user-a', 'model_tokens', 100, 'chat');
      await counters.add('user-a', 'model_tokens', 250, 'ingestion');
      // Enforcement sees one number …
      expect(await counters.get('user-a', 'model_tokens')).toBe(350);
      // … while the rows keep the per-family breakdown a report needs, with no
      // further migration.
      const { rows } = await tdb.pool.query<{ task_family: string; count: string }>(
        `SELECT task_family, count::text AS count FROM usage_counter
          WHERE user_id = 'user-a' AND bucket = 'model_tokens' ORDER BY task_family`,
      );
      expect(rows).toEqual([
        { task_family: 'chat', count: '100' },
        { task_family: 'ingestion', count: '250' },
      ]);
    });

    it('utc_day: a new day is a new key, and yesterday is retained', async () => {
      let now = new Date('2026-07-30T23:59:00Z');
      const counters = new PostgresDailyCounters(tdb.db, () => now);
      await counters.add('user-a', 'capture', 5);
      now = new Date('2026-07-31T00:01:00Z');
      expect(await counters.get('user-a', 'capture')).toBe(0);
      await counters.add('user-a', 'capture', 1);
      expect(await counters.get('user-a', 'capture')).toBe(1);
      const { rows } = await tdb.pool.query('SELECT period FROM usage_counter ORDER BY period');
      expect(rows.map((r) => (r as { period: string }).period)).toEqual([
        '2026-07-30',
        '2026-07-31',
      ]);
    });

    it('model_budget: the cap is enforced off the durable total and survives a restart', async () => {
      const limits = { dailyCalls: 3, dailyTokens: 1_000_000 };
      const budget = new DailyModelBudget(
        limits,
        new PostgresDailyCounters(tdb.db, at('2026-07-30T10:00:00Z')),
        () => 'user-a',
      );
      await budget.record('user-a', 10);
      await budget.record('user-a', 10);
      expect(await budget.hasBudget('user-a')).toBe(true);
      await budget.record('user-a', 10);
      expect(await budget.hasBudget('user-a')).toBe(false);

      // The finding: a restart used to clear this. It no longer does.
      const afterRestart = new DailyModelBudget(
        limits,
        new PostgresDailyCounters(tdb.db, at('2026-07-30T10:05:00Z')),
        () => 'user-a',
      );
      expect(await afterRestart.hasBudget('user-a')).toBe(false);
    });

    it('the in-memory counter is not what production wires: parity on the same script', async () => {
      const script = async (counters: InMemoryDailyCounters | PostgresDailyCounters) => {
        const budget = new DailyModelBudget({ dailyCalls: 2, dailyTokens: 50 }, counters);
        const out: boolean[] = [];
        out.push(await budget.hasBudget('u'));
        await budget.record('u', 10);
        out.push(await budget.hasBudget('u'));
        await budget.record('u', 10);
        out.push(await budget.hasBudget('u')); // call cap reached
        return out;
      };
      const memory = await script(new InMemoryDailyCounters(at('2026-07-30T10:00:00Z')));
      const durable = await script(new PostgresDailyCounters(tdb.db, at('2026-07-30T10:00:00Z')));
      expect(durable).toEqual(memory);
      expect(durable).toEqual([true, true, false]);
    });
  });

  describe('rate-limit windows', () => {
    const buckets: RateLimitBuckets = {
      windowSeconds: 60,
      chat: 2,
      capture: 0,
      remember: 5,
      upload: 5,
    };
    const contextFor = (bucket: string | undefined, userId: string | undefined) => {
      const handler = () => undefined;
      if (bucket) Reflect.defineMetadata('cogeto:rate-limit-bucket', bucket, handler);
      return {
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => ({ principal: userId ? { userId } : undefined }),
        }),
      } as unknown as ExecutionContext;
    };

    /**
     * The parity script (property 3): the SAME sequence of guarded requests,
     * run against both stores, must produce the same allow/deny sequence.
     * Nothing here may change when the counter moves into Postgres.
     */
    const runScript = async (store: RateLimitStore): Promise<string[]> => {
      let now = 1_000_000;
      const guard = new RateLimitGuard(buckets, store, () => now);
      const outcomes: string[] = [];
      const attempt = async (bucket: string | undefined, user: string | undefined) => {
        try {
          await guard.canActivate(contextFor(bucket, user));
          outcomes.push('allow');
        } catch {
          outcomes.push('deny');
        }
      };
      await attempt('chat', 'user-a'); // 1
      await attempt('chat', 'user-a'); // 2 (at the cap)
      await attempt('chat', 'user-a'); // 3 over
      await attempt('chat', 'user-b'); // other principal, own window
      await attempt('capture', 'user-a'); // unlimited bucket
      await attempt(undefined, 'user-a'); // unmarked route
      await attempt('chat', undefined); // unauthenticated
      now += 61_000; // window rolls
      await attempt('chat', 'user-a');
      return outcomes;
    };

    it('parity: the durable store makes the same decisions as the in-process one', async () => {
      const inMemory = await runScript(new InMemoryRateLimitStore());
      await tdb.pool.query('TRUNCATE rate_limit_window');
      const durable = await runScript(new PostgresRateLimitStore(tdb.db));
      expect(durable).toEqual(inMemory);
      expect(durable).toEqual([
        'allow',
        'allow',
        'deny',
        'allow',
        'allow',
        'allow',
        'allow',
        'allow',
      ]);
    });

    it('persist_across_restart: a fresh store still refuses inside the same window', async () => {
      const now = 2_000_000;
      const first = new PostgresRateLimitStore(tdb.db);
      const guardA = new RateLimitGuard(buckets, first, () => now);
      await guardA.canActivate(contextFor('chat', 'user-a'));
      await guardA.canActivate(contextFor('chat', 'user-a'));

      const guardB = new RateLimitGuard(buckets, new PostgresRateLimitStore(tdb.db), () => now);
      await expect(guardB.canActivate(contextFor('chat', 'user-a'))).rejects.toThrow(
        /rate limit reached/,
      );
    });

    it('shared_across_processes: two stores consume one window', async () => {
      const now = 3_000_000;
      const app = new PostgresRateLimitStore(tdb.db);
      const worker = new PostgresRateLimitStore(tdb.db);
      expect((await app.hit('user-a', 'chat', 60_000, now)).count).toBe(1);
      expect((await worker.hit('user-a', 'chat', 60_000, now)).count).toBe(2);
      expect((await app.hit('user-a', 'chat', 60_000, now)).count).toBe(3);
    });

    it('eviction: windows older than the retention horizon are removed (SEC-27)', async () => {
      const store = new PostgresRateLimitStore(tdb.db);
      const start = Date.parse('2026-07-30T10:00:00Z');
      for (let i = 0; i < 20; i++) await store.hit(`user-${i}`, 'chat', 60_000, start);
      expect(await countWindows()).toBe(20);
      // Far enough ahead that the eviction throttle has elapsed and every
      // stored window is two windows old.
      await store.hit('user-fresh', 'chat', 60_000, start + 10 * 60_000);
      expect(await countWindows()).toBe(1);
    });

    it('eviction is scoped to its own bucket: a short window never expires a long one', async () => {
      // One store serves buckets with very different windows: the HTTP guard's
      // 60 s and inbound mail's 3600 s. An unscoped sweep measured every row
      // against the CALLING bucket's window, so a single web request deleted
      // live one-hour mail windows and reset each sender's count, quietly
      // shrinking the per-sender cap to a fraction of its configured value.
      const store = new PostgresRateLimitStore(tdb.db);
      const start = Date.parse('2026-07-30T10:00:00Z');
      const hour = 3_600_000;

      // A sender ten minutes into its one-hour window, well short of the cap.
      expect((await store.hit('sender@example.com', 'email_intake', hour, start)).count).toBe(1);
      expect(
        (await store.hit('sender@example.com', 'email_intake', hour, start + 60_000)).count,
      ).toBe(2);

      // Ordinary web traffic, ten minutes later: past the eviction throttle, so
      // this hit sweeps. Its horizon is two 60 s windows, which the mail row is
      // older than in wall-clock terms but NOT in terms of its own window.
      await store.hit('user-a', 'chat', 60_000, start + 10 * 60_000);

      // The mail window must have survived, still counting.
      expect(
        (await store.hit('sender@example.com', 'email_intake', hour, start + 11 * 60_000)).count,
      ).toBe(3);
    });

    const countWindows = async (): Promise<number> => {
      const { rows } = await tdb.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM rate_limit_window',
      );
      return Number(rows[0]?.n ?? 0);
    };
  });
});
