import { sql } from 'drizzle-orm';
import type { Db } from './db';
import { rateLimitWindow } from './persistence/tables';

/**
 * The fixed-window rate limiter's state (security audit 2.0 SEC-18/SEC-27).
 *
 * `hit` is one atomic "start or extend the current window" step: it returns the
 * request's ordinal within the window and when the window ends. The guard
 * compares the ordinal against the bucket's cap — so the decision logic lives
 * in one place and both the durable and the in-process store answer it
 * identically.
 *
 * The ordinal is 1-based: the first request in a window returns 1, and a bucket
 * with cap N admits ordinals 1..N. That is exactly the pre-audit in-process
 * behaviour, which is the property the migration must not change.
 */
export interface RateLimitHit {
  /** 1-based ordinal of this request inside the current window. */
  count: number;
  /** Epoch millis at which the current window ends. */
  resetAt: number;
}

export abstract class RateLimitStore {
  abstract hit(
    principalId: string,
    bucket: string,
    windowMs: number,
    now: number,
  ): Promise<RateLimitHit>;
}

/** How long an expired window row is kept before the eviction pass removes it. */
const EVICT_AFTER_WINDOWS = 2;
/** At most one eviction pass per this interval, whatever the request rate. */
const EVICT_INTERVAL_MS = 60_000;

/**
 * The durable store: one row per (principal, bucket) in `rate_limit_window`,
 * so the window survives a restart and is shared across processes.
 *
 * The whole check-and-increment is a single statement. `ON CONFLICT DO UPDATE`
 * resets the count when the STORED window has already expired and otherwise
 * increments it, which makes concurrent hits from the app and the worker
 * serialize on the row rather than race.
 */
export class PostgresRateLimitStore extends RateLimitStore {
  private lastEvictionAt = 0;

  constructor(
    private readonly db: Db,
    /** Surfaced for tests; a failed eviction must never fail a request. */
    private readonly onEvictionError: (error: unknown) => void = () => undefined,
  ) {
    super();
  }

  async hit(
    principalId: string,
    bucket: string,
    windowMs: number,
    now: number,
  ): Promise<RateLimitHit> {
    const startedAt = new Date(now);
    // A stored window is expired when it started more than windowMs ago.
    const expiredBefore = new Date(now - windowMs);

    const rows = await this.db
      .insert(rateLimitWindow)
      .values({ principalId, bucket, windowStart: startedAt, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimitWindow.principalId, rateLimitWindow.bucket],
        set: {
          count: sql`CASE WHEN ${rateLimitWindow.windowStart} <= ${expiredBefore}
                          THEN 1 ELSE ${rateLimitWindow.count} + 1 END`,
          windowStart: sql`CASE WHEN ${rateLimitWindow.windowStart} <= ${expiredBefore}
                                THEN ${startedAt} ELSE ${rateLimitWindow.windowStart} END`,
        },
      })
      .returning({ count: rateLimitWindow.count, windowStart: rateLimitWindow.windowStart });

    const row = rows[0];
    const windowStart = row?.windowStart ? new Date(row.windowStart).getTime() : now;
    // Awaited so the sweep is deterministic, but throttled to at most one pass
    // a minute and never able to fail the request (see below).
    await this.evict(now, bucket, windowMs);
    return { count: row?.count ?? 1, resetAt: windowStart + windowMs };
  }

  /**
   * SEC-27: the in-process map this replaced was never evicted, so it grew
   * without bound keyed by principal x bucket. The durable table has the same
   * shape, so it gets the same treatment the identity cache already applies —
   * a cheap, throttled sweep of entries that can no longer matter. Fire and
   * forget: an eviction failure is logged by the caller's hook, never raised
   * into a request.
   *
   * The sweep is scoped to the CALLING BUCKET. One store serves buckets with
   * very different windows (the HTTP guard's 60 s and inbound mail's 3600 s),
   * and the cutoff can only be computed from the window of the bucket we were
   * called for. An unscoped delete therefore measured every other bucket's rows
   * against the wrong window: a single web request evicted live one-hour mail
   * windows two minutes old, which reset each sender's count and silently
   * reduced the per-sender cap to a fraction of its configured value. Scoping
   * the delete keeps every row measured against its own bucket's window; rows
   * of an idle bucket are swept by that bucket's next hit.
   */
  private async evict(now: number, bucket: string, windowMs: number): Promise<void> {
    if (now - this.lastEvictionAt < EVICT_INTERVAL_MS) return;
    this.lastEvictionAt = now;
    try {
      const cutoff = new Date(now - windowMs * EVICT_AFTER_WINDOWS);
      await this.db
        .delete(rateLimitWindow)
        .where(
          sql`${rateLimitWindow.bucket} = ${bucket} AND ${rateLimitWindow.windowStart} < ${cutoff}`,
        );
    } catch (error) {
      this.onEvictionError(error);
    }
  }
}

/**
 * The in-process store, kept for bare constructions and unit tests that run
 * without a database. It now evicts expired entries (SEC-27), which the
 * original never did.
 */
export class InMemoryRateLimitStore extends RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  hit(principalId: string, bucket: string, windowMs: number, now: number): Promise<RateLimitHit> {
    const key = `${bucket}:${principalId}`;
    const state = this.windows.get(key);
    if (!state || now >= state.resetAt) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, fresh);
      this.evict(now);
      return Promise.resolve({ ...fresh });
    }
    state.count += 1;
    return Promise.resolve({ ...state });
  }

  /** Mirrors IdentityService.evictExpired: sweep only once the map is large. */
  private evict(now: number): void {
    if (this.windows.size < 500) return;
    for (const [key, state] of this.windows) {
      if (state.resetAt <= now) this.windows.delete(key);
    }
  }
}
