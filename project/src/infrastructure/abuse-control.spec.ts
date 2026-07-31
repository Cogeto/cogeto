import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { InMemoryDailyCounters } from './daily-counters';
import { DailyModelBudget } from './model-budget';
import { RateLimitGuard } from './rate-limit';
import { InMemoryRateLimitStore } from './rate-limit-store';
import type { RateLimitBuckets } from './limits';

/**: rate limiting, the daily model budget, and daily counters.
 * The durable (Postgres-backed) counterparts of the same three, and the
 * behavioural-parity assertion between the two stores, live in
 * `durable-limits.integration.spec.ts`.
 */
describe('abuse control', () => {
  const buckets: RateLimitBuckets = {
    windowSeconds: 60,
    chat: 2,
    capture: 0, // unlimited
    remember: 5,
    upload: 5,
  };

  const contextFor = (bucket: string | undefined, userId: string | undefined): ExecutionContext => {
    const handler = () => undefined;
    if (bucket) Reflect.defineMetadata('cogeto:rate-limit-bucket', bucket, handler);
    return {
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ principal: userId ? { userId } : undefined }) }),
    } as unknown as ExecutionContext;
  };

  it('rate_limit_guard: allows up to the bucket limit per principal, then 429s; other principals unaffected', async () => {
    let now = 1_000_000;
    const guard = new RateLimitGuard(buckets, new InMemoryRateLimitStore(), () => now);
    const ctxA = contextFor('chat', 'user-a');

    await expect(guard.canActivate(ctxA)).resolves.toBe(true); // 1
    await expect(guard.canActivate(ctxA)).resolves.toBe(true); // 2
    await expect(guard.canActivate(ctxA)).rejects.toThrow(/rate limit reached for chat/); // over

    // A different principal has its own window.
    await expect(guard.canActivate(contextFor('chat', 'user-b'))).resolves.toBe(true);

    // The window resets after windowSeconds.
    now += 61_000;
    await expect(guard.canActivate(ctxA)).resolves.toBe(true);
  });

  it('rate_limit_guard: an unlimited bucket (0), an unmarked route, and an unauthenticated request all pass', async () => {
    const guard = new RateLimitGuard(buckets, new InMemoryRateLimitStore(), () => 1);
    for (let i = 0; i < 100; i++)
      await expect(guard.canActivate(contextFor('capture', 'user-a'))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(undefined, 'user-a'))).resolves.toBe(true); // no @RateLimit
    await expect(guard.canActivate(contextFor('chat', undefined))).resolves.toBe(true); // no principal
  });

  it('rate_limit_eviction: expired windows are dropped once the map is large (SEC-27)', async () => {
    // The pre-audit map was never evicted, so it grew without bound keyed by
    // principal x bucket. Fill past the sweep threshold with windows that all
    // expire, then take one more hit and assert the map shrank.
    const store = new InMemoryRateLimitStore();
    const windows = (store as unknown as { windows: Map<string, unknown> }).windows;
    for (let i = 0; i < 600; i++) await store.hit(`user-${i}`, 'chat', 1000, 1_000_000);
    expect(windows.size).toBe(600);
    // A later hit rolls its own window and triggers the sweep of the rest.
    await store.hit('user-0', 'chat', 1000, 1_000_000 + 5_000);
    expect(windows.size).toBe(1);
  });

  it('model_budget: caps calls and tokens per user per day; unattributed calls are unmetered', async () => {
    const counters = new InMemoryDailyCounters(() => new Date('2026-07-13T10:00:00Z'));
    let currentUser: string | undefined = 'user-a';
    const budget = new DailyModelBudget(
      { dailyCalls: 3, dailyTokens: 1000 },
      counters,
      () => currentUser,
    );

    expect(budget.currentUserId()).toBe('user-a');
    await expect(budget.hasBudget('user-a')).resolves.toBe(true);
    await budget.record('user-a', 100);
    await budget.record('user-a', 100);
    await expect(budget.hasBudget('user-a')).resolves.toBe(true);
    await budget.record('user-a', 100); // 3rd call reaches the call cap
    await expect(budget.hasBudget('user-a')).resolves.toBe(false); // calls exhausted

    // Token cap independently: a fresh user with one huge call is also over.
    await budget.record('user-b', 2000);
    await expect(budget.hasBudget('user-b')).resolves.toBe(false);

    // No attributed user → the decorator skips metering entirely.
    currentUser = undefined;
    expect(budget.currentUserId()).toBeUndefined();
  });

  it('daily_counters: roll over at UTC midnight clears the tallies', async () => {
    let today = new Date('2026-07-13T23:59:00Z');
    const counters = new InMemoryDailyCounters(() => today);
    await counters.add('user-a', 'capture', 5);
    await expect(counters.get('user-a', 'capture')).resolves.toBe(5);
    today = new Date('2026-07-14T00:01:00Z');
    await expect(counters.get('user-a', 'capture')).resolves.toBe(0); // new day
  });
});
