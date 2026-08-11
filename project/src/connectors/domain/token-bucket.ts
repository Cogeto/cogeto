/**
 * Outbound token-bucket arithmetic (V2.5 item 8.1, issue E), pure so the
 * refill and wait math is unit-testable without a clock or a database. The
 * durable state (tokens, refill stamp, the Retry-After wall) lives in
 * `connector_rate_limit`; this file only computes.
 *
 * The one rule that matters: backoff never retries into the same wall. The
 * next permitted attempt is the LATER of the bucket's own refill and the
 * `Retry-After` the upstream named.
 */

export interface BucketState {
  tokens: number;
  refilledAt: Date;
  retryAfterUntil: Date | null;
}

export interface BucketProfile {
  capacity: number;
  refillPerSecond: number;
}

/** A conservative default for descriptors that declare no profile. */
export const DEFAULT_RATE_PROFILE: BucketProfile = { capacity: 10, refillPerSecond: 1 };

/** The state as of `now`, with elapsed refill applied. */
export function refill(state: BucketState, profile: BucketProfile, now: Date): BucketState {
  const elapsedSeconds = Math.max(0, (now.getTime() - state.refilledAt.getTime()) / 1000);
  const tokens = Math.min(
    profile.capacity,
    state.tokens + elapsedSeconds * profile.refillPerSecond,
  );
  return { ...state, tokens, refilledAt: now };
}

/**
 * Try to take one token. Either it is granted (with the new state to
 * persist) or the caller learns how long to wait, honouring both the bucket
 * and any Retry-After wall.
 */
export function acquire(
  state: BucketState,
  profile: BucketProfile,
  now: Date,
): { granted: true; state: BucketState } | { granted: false; waitSeconds: number } {
  if (state.retryAfterUntil && state.retryAfterUntil.getTime() > now.getTime()) {
    const wallWait = (state.retryAfterUntil.getTime() - now.getTime()) / 1000;
    return { granted: false, waitSeconds: Math.ceil(wallWait) };
  }
  const current = refill(state, profile, now);
  if (current.tokens >= 1) {
    return {
      granted: true,
      state: { ...current, tokens: current.tokens - 1, retryAfterUntil: null },
    };
  }
  const deficit = 1 - current.tokens;
  return { granted: false, waitSeconds: Math.ceil(deficit / profile.refillPerSecond) };
}

/** Record the wall the upstream named (429 / Retry-After). */
export function recordRetryAfter(state: BucketState, now: Date, seconds: number): BucketState {
  const until = new Date(now.getTime() + Math.max(1, seconds) * 1000);
  const existing = state.retryAfterUntil?.getTime() ?? 0;
  return { ...state, retryAfterUntil: existing > until.getTime() ? state.retryAfterUntil : until };
}

/** A fresh bucket starts full: a new connector may burst to capacity. */
export function freshBucket(profile: BucketProfile, now: Date): BucketState {
  return { tokens: profile.capacity, refilledAt: now, retryAfterUntil: null };
}
