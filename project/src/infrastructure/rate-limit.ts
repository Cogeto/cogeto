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

/**
 * Per-principal request rate limiting (FIX-2 QS-2). A lightweight in-process
 * fixed-window limiter — no new dependency, right-sized for the single app
 * process that serves one tenant (§A.2). Apply with `@RateLimit('<bucket>')` on
 * a route; the guard keys on the authenticated principal, so it must run AFTER
 * the bearer guard (list it as a method guard on a controller already guarded
 * by BearerAuthGuard). A bucket configured to 0 is unlimited.
 */

export type RateLimitBucket = keyof Omit<RateLimitBuckets, 'windowSeconds'>;

const RATE_LIMIT_KEY = 'cogeto:rate-limit-bucket';

/** Marks a route with the rate-limit bucket whose cap the guard enforces. */
export const RateLimit = (bucket: RateLimitBucket): MethodDecorator =>
  SetMetadata(RATE_LIMIT_KEY, bucket);

interface WindowState {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    @Inject(RATE_LIMIT_OPTIONS) private readonly buckets: RateLimitBuckets,
    // @Optional so Nest does not try to inject the test clock (default applies).
    @Optional() private readonly now: () => number = () => Date.now(),
  ) {}

  canActivate(context: ExecutionContext): boolean {
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

    const key = `${bucket}:${userId}`;
    const now = this.now();
    const windowMs = this.buckets.windowSeconds * 1000;
    const state = this.windows.get(key);
    if (!state || now >= state.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (state.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `rate limit reached for ${bucket} — retry in ${retryAfter}s`,
          retryAfterSeconds: retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    state.count += 1;
    return true;
  }
}
