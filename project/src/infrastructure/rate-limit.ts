import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { RATE_LIMIT_OPTIONS } from './limits';
import type { RateLimitBuckets } from './limits';
import { InMemoryRateLimitStore, RateLimitStore } from './rate-limit-store';

/**
 * Per-principal request rate limiting. A fixed-window limiter over
 * {@link RateLimitStore}. Apply with `@RateLimit('<bucket>')` on a route; the
 * guard keys on the authenticated principal, so it must run AFTER the bearer
 * guard (list it as a method guard on a controller already guarded by
 * BearerAuthGuard). A bucket configured to 0 is unlimited.
 *
 * Security audit 2.0 SEC-18/SEC-27: the window state used to be a per-process
 * `Map` that was never evicted, so a restart cleared every window and the map
 * grew without bound. It is now a `rate_limit_window` row (durable, shared
 * across processes, evicted) — the DECISION logic below is unchanged, which is
 * the property the migration must preserve.
 */

export type RateLimitBucket = keyof Omit<RateLimitBuckets, 'windowSeconds'>;

const RATE_LIMIT_KEY = 'cogeto:rate-limit-bucket';

/** Marks a route with the rate-limit bucket whose cap the guard enforces. */
export const RateLimit = (bucket: RateLimitBucket): MethodDecorator =>
  SetMetadata(RATE_LIMIT_KEY, bucket);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly store: RateLimitStore;

  constructor(
    @Inject(RATE_LIMIT_OPTIONS) private readonly buckets: RateLimitBuckets,
    // @Optional so Nest does not try to inject the test clock / a store into a
    // bare construction. Without a store the limiter stays in-process, which is
    // the pre-audit behaviour and is only reached by tests and bare builds.
    @Optional() store?: RateLimitStore,
    @Optional() private readonly now: () => number = () => Date.now(),
  ) {
    this.store = store ?? new InMemoryRateLimitStore();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket = Reflect.getMetadata(RATE_LIMIT_KEY, context.getHandler()) as
      RateLimitBucket | undefined;
    if (!bucket) return true;

    const limit = this.buckets[bucket];
    if (!limit || limit <= 0) return true; // 0/absent = unlimited

    const request = context
      .switchToHttp()
      .getRequest<Request & { principal?: { userId: string } }>();
    // No principal (unauthenticated route) → nothing to key on; let it through.
    const userId = request.principal?.userId;
    if (!userId) return true;

    const now = this.now();
    const windowMs = this.buckets.windowSeconds * 1000;
    const { count, resetAt } = await this.store.hit(userId, bucket, windowMs, now);
    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `rate limit reached for ${bucket}, retry in ${retryAfter}s`,
          retryAfterSeconds: retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
