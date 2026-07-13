import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import {
  INGEST_QUOTA,
  MODEL_USAGE_METER,
  PARSE_CAPS,
  RATE_LIMIT_OPTIONS,
  SSE_LIMITS,
} from './limits';
import type { LimitsConfig } from './limits';
import { DailyCounters } from './daily-counters';
import { InMemoryModelBudget } from './model-budget';
import { RateLimitGuard } from './rate-limit';

/**
 * Provides the resolved abuse/DoS limits (FIX-2) as a GLOBAL module so the
 * rate-limit guard, ingest quota, SSE caps and model budget are injectable
 * everywhere they are enforced (connectors, retrieval, the gateway) without any
 * module importing an entrypoint. Registered once by each composition root with
 * the effective `LimitsConfig`.
 *
 * The model budget shares the single {@link DailyCounters} instance with the
 * ingest quota, and reads the attributed user from the per-request usage scope
 * — so the worker (which opens no scope) is unmetered.
 */
@Module({})
export class LimitsModule {
  static register(limits: LimitsConfig): DynamicModule {
    return {
      module: LimitsModule,
      global: true,
      providers: [
        // useFactory (not the bare class): DailyCounters' constructor takes an
        // optional clock, which Nest would otherwise try to inject.
        { provide: DailyCounters, useFactory: () => new DailyCounters() },
        { provide: RATE_LIMIT_OPTIONS, useValue: limits.rateLimit },
        { provide: INGEST_QUOTA, useValue: limits.ingestQuota },
        { provide: SSE_LIMITS, useValue: limits.sse },
        { provide: PARSE_CAPS, useValue: limits.parse },
        RateLimitGuard,
        {
          provide: MODEL_USAGE_METER,
          useFactory: (counters: DailyCounters) =>
            new InMemoryModelBudget(limits.modelBudget, counters),
          inject: [DailyCounters],
        },
      ],
      exports: [
        DailyCounters,
        RATE_LIMIT_OPTIONS,
        INGEST_QUOTA,
        SSE_LIMITS,
        PARSE_CAPS,
        MODEL_USAGE_METER,
        RateLimitGuard,
      ],
    };
  }
}
