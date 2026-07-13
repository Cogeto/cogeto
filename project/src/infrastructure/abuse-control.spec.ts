import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { DailyCounters } from './daily-counters';
import { InMemoryModelBudget } from './model-budget';
import { RateLimitGuard } from './rate-limit';
import type { RateLimitBuckets } from './limits';

/** FIX-2 QS-2: rate limiting, the daily model budget, and daily counters. */
describe('abuse control (QS-2)', () => {
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

  it('rate_limit_guard: allows up to the bucket limit per principal, then 429s; other principals unaffected', () => {
    let now = 1_000_000;
    const guard = new RateLimitGuard(buckets, () => now);
    const ctxA = contextFor('chat', 'user-a');

    expect(guard.canActivate(ctxA)).toBe(true); // 1
    expect(guard.canActivate(ctxA)).toBe(true); // 2
    expect(() => guard.canActivate(ctxA)).toThrow(/rate limit reached for chat/); // over

    // A different principal has its own window.
    expect(guard.canActivate(contextFor('chat', 'user-b'))).toBe(true);

    // The window resets after windowSeconds.
    now += 61_000;
    expect(guard.canActivate(ctxA)).toBe(true);
  });

  it('rate_limit_guard: an unlimited bucket (0), an unmarked route, and an unauthenticated request all pass', () => {
    const guard = new RateLimitGuard(buckets, () => 1);
    for (let i = 0; i < 100; i++)
      expect(guard.canActivate(contextFor('capture', 'user-a'))).toBe(true);
    expect(guard.canActivate(contextFor(undefined, 'user-a'))).toBe(true); // no @RateLimit
    expect(guard.canActivate(contextFor('chat', undefined))).toBe(true); // no principal
  });

  it('model_budget: caps calls and tokens per user per day; unattributed calls are unmetered', () => {
    const counters = new DailyCounters(() => new Date('2026-07-13T10:00:00Z'));
    let currentUser: string | undefined = 'user-a';
    const budget = new InMemoryModelBudget(
      { dailyCalls: 3, dailyTokens: 1000 },
      counters,
      () => currentUser,
    );

    expect(budget.currentUserId()).toBe('user-a');
    expect(budget.hasBudget('user-a')).toBe(true);
    budget.record('user-a', 100);
    budget.record('user-a', 100);
    expect(budget.hasBudget('user-a')).toBe(true);
    budget.record('user-a', 100); // 3rd call reaches the call cap
    expect(budget.hasBudget('user-a')).toBe(false); // calls exhausted

    // Token cap independently: a fresh user with one huge call is also over.
    budget.record('user-b', 2000);
    expect(budget.hasBudget('user-b')).toBe(false);

    // No attributed user → the decorator skips metering entirely.
    currentUser = undefined;
    expect(budget.currentUserId()).toBeUndefined();
  });

  it('daily_counters: roll over at UTC midnight clears the tallies', () => {
    let today = new Date('2026-07-13T23:59:00Z');
    const counters = new DailyCounters(() => today);
    counters.add('user-a', 'capture', 5);
    expect(counters.get('user-a', 'capture')).toBe(5);
    today = new Date('2026-07-14T00:01:00Z');
    expect(counters.get('user-a', 'capture')).toBe(0); // new day
  });
});
