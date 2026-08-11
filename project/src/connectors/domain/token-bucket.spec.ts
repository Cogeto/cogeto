import { describe, expect, it } from 'vitest';
import { acquire, freshBucket, recordRetryAfter, refill } from './token-bucket';

const profile = { capacity: 5, refillPerSecond: 1 };
const t0 = new Date('2026-08-11T12:00:00Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

describe('token_bucket: outbound politeness that never retries into a wall', () => {
  it('a_fresh_bucket_bursts_to_capacity_then_denies', () => {
    let state = freshBucket(profile, t0);
    for (let i = 0; i < 5; i += 1) {
      const result = acquire(state, profile, t0);
      expect(result.granted).toBe(true);
      if (result.granted) state = result.state;
    }
    const denied = acquire(state, profile, t0);
    expect(denied.granted).toBe(false);
    if (!denied.granted) expect(denied.waitSeconds).toBeGreaterThan(0);
  });

  it('elapsed_time_refills_up_to_capacity_never_beyond', () => {
    let state = freshBucket(profile, t0);
    for (let i = 0; i < 5; i += 1) {
      const result = acquire(state, profile, t0);
      if (result.granted) state = result.state;
    }
    // Three seconds restores three tokens; an hour restores five, not 3600.
    expect(refill(state, profile, at(3)).tokens).toBeCloseTo(3);
    expect(refill(state, profile, at(3600)).tokens).toBe(5);
  });

  it('retry_after_wins_over_an_available_token', () => {
    // The rule the issue names: backoff must not merely retry into the same
    // wall. A full bucket still waits when the upstream named a wall.
    const walled = recordRetryAfter(freshBucket(profile, t0), t0, 120);
    const result = acquire(walled, profile, at(30));
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.waitSeconds).toBe(90);
  });

  it('the_wall_expires_and_the_bucket_takes_over', () => {
    const walled = recordRetryAfter(freshBucket(profile, t0), t0, 60);
    const after = acquire(walled, profile, at(61));
    expect(after.granted).toBe(true);
  });

  it('a_later_wall_is_never_shortened_by_an_earlier_one', () => {
    const long = recordRetryAfter(freshBucket(profile, t0), t0, 300);
    const shortened = recordRetryAfter(long, at(1), 10);
    expect(shortened.retryAfterUntil).toEqual(long.retryAfterUntil);
  });
});
