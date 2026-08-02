/**
 * Public interface of the shared infrastructure (sanctioned by spec §15.4 and the
 * prompt: outbox, queue contract, audit, database access). Imports no
 * domain module and no seam — enforced by dependency-cruiser.
 */
export { DatabaseModule } from './database.module';
export { createDb, DRIZZLE, PG_POOL } from './db';
export type { Db, DbOrTx, Tx } from './db';
export { applyMigrations } from './migrations';
export type { MigrationRunResult } from './migrations';
export { writeAudit } from './audit';
export type { AuditEntry } from './audit';
export { withTransactionalEnqueue, JOB_PRINCIPAL_KEY } from './outbox';
export type { DomainEvent, JobSpec } from './outbox';
export {
  idempotentTask,
  acquireJobRunLock,
  tryJobRunLock,
  consumeIdempotencyKey,
  runSingleFlight,
} from './queue';
export type { IdempotentJobPayload, JobIdempotencyKey, AfterCommit } from './queue';
export { scrubMessage, describeError, describeErrorLine } from './error-scrub';
export {
  ensureInstanceKeys,
  loadInstanceSigner,
  loadInstancePublicKey,
  verifyWithPublicKey,
  assertAppKeyMount,
  PUBLIC_KEY_FILE,
  PRIVATE_KEY_FILE,
} from './instance-key';
export type { InstanceSigner } from './instance-key';
export {
  auditLog,
  outboxEvent,
  jobExecution,
  deadLetter,
  attentionState,
  attentionDismissal,
  userContext,
  contextSuggestionDismissal,
  usageCounter,
  rateLimitWindow,
} from './persistence/tables';
// Per-user instance context + language preference (-0053).
export {
  UserContextService,
  normalizeValue,
  hasProfileContext,
  EMPTY_USER_CONTEXT,
} from './user-context';
export type { UserContextRecord } from './user-context';
export { UserContextModule } from './user-context.module';
export {
  buildContextBlock,
  formatNow,
  formatUserContext,
  formatLanguageRule,
  LANGUAGE_NAMES,
} from './context-block';
export type { ContextBlockOptions } from './context-block';
// The server-side copy catalogue (V2.0 item 3.5): the words Cogeto writes on
// its own, keyed and per-locale. Not prompt assembly, not log lines.
export { serverT, serverTranslator, SERVER_NAMESPACES } from './i18n';
export type { ServerNamespace, ServerTOptions } from './i18n';
// Abuse/DoS limits (:). Types + tokens live here so the
// guards enforce them inside domain modules without importing an entrypoint.
export {
  RATE_LIMIT_OPTIONS,
  INGEST_QUOTA,
  RESEARCH_QUOTA,
  SSE_LIMITS,
  MODEL_USAGE_METER,
  PARSE_CAPS,
  DEFAULT_PARSE_CAPS,
  INSTANCE_TIMEZONE,
  DEFAULT_INSTANCE_TIMEZONE,
} from './limits';
export type {
  LimitsConfig,
  RateLimitBuckets,
  ModelBudget,
  IngestQuota,
  ResearchQuota,
  SseLimits,
  ParseCaps,
} from './limits';
export { LimitsModule } from './limits.module';
export {
  DailyCounters,
  InMemoryDailyCounters,
  PostgresDailyCounters,
  utcDay,
} from './daily-counters';
export { RateLimitGuard, RateLimit } from './rate-limit';
export type { RateLimitBucket } from './rate-limit';
export { RateLimitStore, InMemoryRateLimitStore, PostgresRateLimitStore } from './rate-limit-store';
export type { RateLimitHit } from './rate-limit-store';
export { DailyModelBudget, MODEL_CALLS_BUCKET, MODEL_TOKENS_BUCKET } from './model-budget';
export type { ModelUsageMeter } from './model-budget';
export {
  runWithUsageContext,
  setUsageUser,
  setUsageTaskFamily,
  currentUsageUserId,
  currentUsageTaskFamily,
} from './usage-context';
