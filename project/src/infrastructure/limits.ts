/**
 * Abuse/DoS limit TYPES + DI tokens (FIX-2: QS-2, QS-6, QS-14).
 *
 * These live in infrastructure (a leaf both the composition roots and the
 * domain controllers import) so the rate-limit guard, the ingest quota, and the
 * SSE caps can be enforced inside connectors/retrieval without those modules
 * depending on an entrypoint. The concrete VALUES are resolved from the
 * environment at boot (`entrypoints/limits.ts`) and provided via LimitsModule.
 */

export interface RateLimitBuckets {
  /** Fixed-window length shared by all buckets, seconds. */
  windowSeconds: number;
  /** Max requests per principal per window; 0 = unlimited. */
  chat: number;
  capture: number;
  remember: number;
  upload: number;
}

export interface ModelBudget {
  /** Max user-attributed model CALLS per principal per calendar day. */
  dailyCalls: number;
  /** Max estimated model TOKENS (in+out) per principal per calendar day. */
  dailyTokens: number;
}

export interface IngestQuota {
  /** Max note captures per principal per calendar day. */
  captureMax: number;
  /** Max file uploads per principal per calendar day. */
  uploadMax: number;
}

export interface ResearchQuota {
  /** Max web-research searches per principal per calendar day (0 = research off). */
  searchesMax: number;
  /** Max fetched pages per principal per calendar day. */
  pagesMax: number;
  /** Max pages fetched by a single capture request (the per-research cap). */
  pagesPerRunMax: number;
}

export interface SseLimits {
  /** Max simultaneous chat SSE streams per principal. */
  maxConcurrentPerPrincipal: number;
  /** Abort a stream after this many seconds with no token written. */
  idleTimeoutSeconds: number;
  /** Hard ceiling on a single stream's wall-clock duration, seconds. */
  maxDurationSeconds: number;
}

export interface ParseCaps {
  /** Reject extracted document text longer than this many characters (zip-bomb
   * guard — bounds DECOMPRESSED text, which the upload byte cap does not). */
  maxTextChars: number;
  /** Cap the number of chunks a single source is split into. */
  maxChunks: number;
  /** Wall-clock timeout around a single document parse, seconds. */
  timeoutSeconds: number;
  /** Cap the extractor's facts array per source (`.max()` at the schema). */
  maxFacts: number;
}

export interface LimitsConfig {
  rateLimit: RateLimitBuckets;
  modelBudget: ModelBudget;
  ingestQuota: IngestQuota;
  researchQuota: ResearchQuota;
  sse: SseLimits;
  parse: ParseCaps;
}

/** DI tokens for the resolved limit values (provided by LimitsModule). */
export const RATE_LIMIT_OPTIONS = Symbol('RATE_LIMIT_OPTIONS');
export const INGEST_QUOTA = Symbol('INGEST_QUOTA');
export const RESEARCH_QUOTA = Symbol('RESEARCH_QUOTA');
export const SSE_LIMITS = Symbol('SSE_LIMITS');
export const MODEL_USAGE_METER = Symbol('MODEL_USAGE_METER');
export const PARSE_CAPS = Symbol('PARSE_CAPS');

/**
 * Instance timezone (QS-32) — the IANA zone relative-date resolution ("today",
 * "last Monday") uses to fix a note's calendar date from its UTC created_at.
 * Provided by LimitsModule from `config.timezone`; injected @Optional so bare
 * builds fall back to {@link DEFAULT_INSTANCE_TIMEZONE}.
 */
export const INSTANCE_TIMEZONE = Symbol('INSTANCE_TIMEZONE');

/** Default instance timezone (QS-32); mirrors temporal-resolver's DEFAULT_TIMEZONE. */
export const DEFAULT_INSTANCE_TIMEZONE = 'Europe/Zagreb';

/**
 * Fallback parse caps for bare/test constructions (createIngestionPipeline,
 * a directly-instantiated FileSourceReader) that run without LimitsModule.
 * Production wiring always injects the env-resolved values. Kept generous so it
 * never bites a legitimate document in a test.
 */
export const DEFAULT_PARSE_CAPS: ParseCaps = {
  maxTextChars: 1_000_000,
  maxChunks: 200,
  timeoutSeconds: 30,
  maxFacts: 100,
};
