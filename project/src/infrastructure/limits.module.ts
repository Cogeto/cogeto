import { Logger, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import {
  DEFAULT_INSTANCE_TIMEZONE,
  INGEST_QUOTA,
  INSTANCE_TIMEZONE,
  MODEL_USAGE_METER,
  PARSE_CAPS,
  RATE_LIMIT_OPTIONS,
  RESEARCH_QUOTA,
  SSE_LIMITS,
} from './limits';
import type { LimitsConfig } from './limits';
import { DailyCounters, PostgresDailyCounters } from './daily-counters';
import { DRIZZLE } from './db';
import type { Db } from './db';
import { DailyModelBudget } from './model-budget';
import { PostgresRateLimitStore, RateLimitStore } from './rate-limit-store';
import { RateLimitGuard } from './rate-limit';
import { currentUsageTaskFamily, currentUsageUserId } from './usage-context';

/**
 * Provides the resolved abuse/DoS limits as a GLOBAL module so the
 * rate-limit guard, ingest quota, SSE caps and model budget are injectable
 * everywhere they are enforced (connectors, retrieval, the gateway) without any
 * module importing an entrypoint. Registered once by each composition root with
 * the effective `LimitsConfig`.
 *
 * Security audit 2.0 SEC-18: every counter here is DURABLE. The counters and
 * the rate-limit windows are Postgres rows (migration 0038), so a restart no
 * longer clears the only ceiling on model spend and the app and worker share
 * one number rather than counting their own halves. The database handle comes
 * from the global DatabaseModule, which both composition roots register.
 */
@Module({})
export class LimitsModule {
  static register(limits: LimitsConfig, timeZone?: string): DynamicModule {
    const logger = new Logger('limits');
    return {
      module: LimitsModule,
      global: true,
      providers: [
        {
          provide: DailyCounters,
          useFactory: (db: Db) => new PostgresDailyCounters(db),
          inject: [DRIZZLE],
        },
        {
          provide: RateLimitStore,
          useFactory: (db: Db) =>
            new PostgresRateLimitStore(db, (error) =>
              logger.warn(
                `rate-limit window eviction failed (limits unaffected): ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            ),
          inject: [DRIZZLE],
        },
        { provide: RATE_LIMIT_OPTIONS, useValue: limits.rateLimit },
        { provide: INGEST_QUOTA, useValue: limits.ingestQuota },
        { provide: RESEARCH_QUOTA, useValue: limits.researchQuota },
        { provide: SSE_LIMITS, useValue: limits.sse },
        { provide: PARSE_CAPS, useValue: limits.parse },
        // The instance timezone for relative-date resolution.
        { provide: INSTANCE_TIMEZONE, useValue: timeZone ?? DEFAULT_INSTANCE_TIMEZONE },
        {
          provide: RateLimitGuard,
          useFactory: (buckets: LimitsConfig['rateLimit'], store: RateLimitStore) =>
            new RateLimitGuard(buckets, store),
          inject: [RATE_LIMIT_OPTIONS, RateLimitStore],
        },
        {
          provide: MODEL_USAGE_METER,
          useFactory: (counters: DailyCounters) =>
            new DailyModelBudget(
              limits.modelBudget,
              counters,
              currentUsageUserId,
              currentUsageTaskFamily,
            ),
          inject: [DailyCounters],
        },
      ],
      exports: [
        DailyCounters,
        RateLimitStore,
        RATE_LIMIT_OPTIONS,
        INGEST_QUOTA,
        RESEARCH_QUOTA,
        SSE_LIMITS,
        PARSE_CAPS,
        INSTANCE_TIMEZONE,
        MODEL_USAGE_METER,
        RateLimitGuard,
      ],
    };
  }
}
