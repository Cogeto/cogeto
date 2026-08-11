/**
 * Public interface of the shared infrastructure (sanctioned by spec §15.4 and the
 * prompt: outbox, queue contract, audit, database access). Imports no
 * domain module and no seam — enforced by dependency-cruiser.
 *
 * **This barrel exports no live Drizzle table** (spec §15.2, V2.0 item 3.6).
 * It used to re-export ten of them, which turned every cross-module table read
 * into a legal-looking barrel import that the persistence rule could not see.
 * Infrastructure's tables are read through the narrow functions below
 * (`readAuditEntries`, `jobRunState`, `writeAudit`, the outbox and counter
 * helpers); the table objects stay in `./persistence/tables`, importable only
 * from inside this directory. See `docs/module-boundary-contract.md`.
 */
export { DatabaseModule } from './database.module';
export { createDb, DRIZZLE, PG_POOL } from './db';
export type { Db, DbOrTx, Tx } from './db';
export { applyMigrations } from './migrations';
export { writeAudit, readAuditEntries, readAuditPage } from './audit';
export { InstanceProbes } from './instance-probes';
export { enqueueDelayedJob, withTransactionalEnqueue, JOB_PRINCIPAL_KEY } from './outbox';
export {
  idempotentTask,
  acquireJobRunLock,
  tryJobRunLock,
  consumeIdempotencyKey,
  releaseAbandonedJobLocks,
  runSingleFlight,
  jobRunState,
  clearIdempotencyForReprocess,
  listQueuedJobs,
  recentJobExecutions,
  listDeadLetters,
  queueTotals,
  settleQueueBookkeeping,
  retryDeadLetter,
} from './queue';
export type { QueuedJobRow } from './queue';
export { describeError, describeErrorLine } from './error-scrub';
// Sealed secrets under the instance master key (V2.4 item 7.1, moved here in
// V2.5 item 8.1 so provider keys and connector credentials share ONE
// mechanism). Every sealed column is opened in exactly one function, asserted
// by that column's own confinement spec.
export {
  readMasterKey,
  sealSecret,
  openSecret,
  sameSecret,
  MasterKeyError,
  SecretUnreadableError,
  MASTER_KEY_MISSING,
} from './secret-box';
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
// Per-user instance context + language preference (-0053).
export {
  UserContextService,
  normalizeValue,
  hasProfileContext,
  EMPTY_USER_CONTEXT,
} from './user-context';
export type { UserContextRecord } from './user-context';
export { UserContextModule } from './user-context.module';
export { buildContextBlock, formatNow } from './context-block';
// The server-side copy catalogue (V2.0 item 3.5): the words Cogeto writes on
// its own, keyed and per-locale. Not prompt assembly, not log lines.
export { serverT, serverTranslator } from './i18n';
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
export type { LimitsConfig, IngestQuota, ResearchQuota, SseLimits, ParseCaps } from './limits';
export { LimitsModule } from './limits.module';
export { DailyCounters, InMemoryDailyCounters, PostgresDailyCounters } from './daily-counters';
// Zod at every boundary (AGENTS.md), adapted to HTTP in one place
// (V2.0 item 3.7).
export { parseOrBadRequest } from './request-validation';
export { RateLimitGuard, RateLimit } from './rate-limit';
export { RateLimitStore, InMemoryRateLimitStore, PostgresRateLimitStore } from './rate-limit-store';
export { DailyModelBudget } from './model-budget';
export type { ModelUsageMeter } from './model-budget';
// Model-egress audit (V2.0 item 3.7): the gateway seam records what left the
// instance through the trail's own table, which infrastructure owns.
export { MODEL_EGRESS_AUDIT } from './model-egress-audit';
export type { ModelEgressAudit, ModelEgressEntry } from './model-egress-audit';
export {
  runWithUsageContext,
  setUsageUser,
  setUsageTaskFamily,
  currentUsageUserId,
} from './usage-context';

// Set-based job states for one page of catalog refs (V2.2 item 5.2).
export { jobRunStates } from './queue';
