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
export { idempotentTask } from './queue';
export type { IdempotentJobPayload } from './queue';
export { auditLog, outboxEvent, jobExecution, deadLetter } from './persistence/tables';
