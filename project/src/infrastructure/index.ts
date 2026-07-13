/**
 * Public interface of the shared infrastructure (sanctioned by §A.3 and the
 * S1-B prompt: outbox, queue contract, audit, database access). Imports no
 * domain module and no seam — enforced by dependency-cruiser.
 */
export { DatabaseModule } from './database.module';
export { createDb, DRIZZLE, PG_POOL } from './db';
export type { Db, DbOrTx, Tx } from './db';
export { applyMigrations } from './migrations';
export type { MigrationRunResult } from './migrations';
export { writeAudit } from './audit';
export type { AuditEntry } from './audit';
export { withTransactionalEnqueue } from './outbox';
export type { DomainEvent, JobSpec } from './outbox';
export { idempotentTask, acquireJobRunLock, tryJobRunLock, consumeIdempotencyKey } from './queue';
export type { IdempotentJobPayload, JobIdempotencyKey, AfterCommit } from './queue';
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
export { auditLog, outboxEvent, jobExecution, deadLetter } from './persistence/tables';
// Abuse/DoS limits (FIX-2: QS-2, QS-6, QS-14). Types + tokens live here so the
// guards enforce them inside domain modules without importing an entrypoint.
export {
  RATE_LIMIT_OPTIONS,
  INGEST_QUOTA,
  SSE_LIMITS,
  MODEL_USAGE_METER,
  PARSE_CAPS,
  DEFAULT_PARSE_CAPS,
} from './limits';
export type {
  LimitsConfig,
  RateLimitBuckets,
  ModelBudget,
  IngestQuota,
  SseLimits,
  ParseCaps,
} from './limits';
export { LimitsModule } from './limits.module';
export { DailyCounters } from './daily-counters';
export { RateLimitGuard, RateLimit } from './rate-limit';
export type { RateLimitBucket } from './rate-limit';
export { InMemoryModelBudget } from './model-budget';
export type { ModelUsageMeter } from './model-budget';
export { runWithUsageContext, setUsageUser, currentUsageUserId } from './usage-context';
