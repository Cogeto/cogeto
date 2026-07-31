import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db';
import { usageCounter } from './persistence/tables';

/**
 * Per-user, per-day counters. Back BOTH the model budget and the
 * capture/upload/research quotas.
 *
 * Security audit 2.0 SEC-18: these used to be a process-local `Map`, so a
 * restart cleared them. That made the model budget and the ingest quota, the
 * only defence against an abusive or runaway account draining the operator's
 * model spend, resettable by anything that restarts the app — including an app
 * crash-looping under attack. They are now rows in `usage_counter`
 * (migration 0038), shared by the app and the worker and durable across a
 * restart. `DailyCounters` is the abstract DI token; production wires
 * {@link PostgresDailyCounters}, bare/unit constructions use
 * {@link InMemoryDailyCounters}.
 *
 * A "day" is the UTC calendar day. Rolling over writes a new key rather than
 * clearing anything, so yesterday's counts survive for reporting.
 */
export abstract class DailyCounters {
  /** Current count for (user, bucket) on today's date, summed over task families. */
  abstract get(userId: string, bucket: string): Promise<number>;
  /**
   * Increment (user, bucket) by n and return the new total for the bucket.
   * `taskFamily` records WHAT caused the spend (ingestion, chat, dreaming, …);
   * it never changes the enforced total, which always sums over families.
   */
  abstract add(userId: string, bucket: string, n?: number, taskFamily?: string): Promise<number>;
}

/** UTC calendar day, e.g. "2026-07-13". */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The durable implementation. One atomic upsert per increment
 * (`ON CONFLICT DO UPDATE SET count = count + n`), so concurrent app and worker
 * processes cannot lose an increment, and one indexed sum per read.
 */
export class PostgresDailyCounters extends DailyCounters {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  async get(userId: string, bucket: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<string | null>`sum(${usageCounter.count})` })
      .from(usageCounter)
      .where(
        and(
          eq(usageCounter.userId, userId),
          eq(usageCounter.bucket, bucket),
          eq(usageCounter.period, utcDay(this.now())),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async add(userId: string, bucket: string, n = 1, taskFamily = ''): Promise<number> {
    const period = utcDay(this.now());
    await this.db
      .insert(usageCounter)
      .values({ userId, bucket, period, taskFamily, count: n })
      .onConflictDoUpdate({
        target: [
          usageCounter.userId,
          usageCounter.bucket,
          usageCounter.period,
          usageCounter.taskFamily,
        ],
        set: {
          count: sql`${usageCounter.count} + ${n}`,
          updatedAt: sql`now()`,
        },
      });
    return this.get(userId, bucket);
  }
}

/**
 * The in-process implementation, kept for bare constructions and unit tests
 * that run without a database. Behaviourally identical within one process;
 * it is NOT what production wires (see {@link PostgresDailyCounters}).
 */
export class InMemoryDailyCounters extends DailyCounters {
  private day = '';
  private readonly counts = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {
    super();
  }

  private roll(): void {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
    }
  }

  get(userId: string, bucket: string): Promise<number> {
    this.roll();
    return Promise.resolve(this.counts.get(`${bucket}:${userId}`) ?? 0);
  }

  add(userId: string, bucket: string, n = 1): Promise<number> {
    this.roll();
    const key = `${bucket}:${userId}`;
    const next = (this.counts.get(key) ?? 0) + n;
    this.counts.set(key, next);
    return Promise.resolve(next);
  }
}
