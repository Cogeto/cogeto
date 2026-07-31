import { sql } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { outboxEvent } from './persistence/tables';
import { currentUsageUserId } from './usage-context';

export interface DomainEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface JobSpec {
  type: string;
  /** Must carry source_type + source_id — the idempotency key (spec §15.4). */
  payload: { source_type: string; source_id: string } & Record<string, unknown>;
  maxAttempts?: number;
  /**
   * The user this job's model spend is charged to (security audit 2.0 SEC-10).
   * Defaults to the enqueuing usage scope's principal, which covers every
   * request-driven enqueue and every worker-driven follow-up enqueue. Pass it
   * explicitly where there is no usage scope — the mail intake runs under a
   * shared-secret guard, not a Principal, so it names the resolved owner here.
   * Absent on both sides means the job is unattributed and, exactly as before,
   * unmetered.
   */
  principalId?: string;
}

/** The additive payload key the worker reads to open its usage scope. */
export const JOB_PRINCIPAL_KEY = 'principal_id';

/**
 * Transactional enqueue — the outbox (spec §15.4): the domain event and its job are
 * written in the CALLER's transaction, in the same commit as the state change.
 * Nothing can be ingested and silently unprocessed; a rolled-back transaction
 * leaves neither an event nor a job.
 *
 * The job payload additionally carries `principal_id` whenever one is known.
 * It is purely additive: a payload enqueued before this change (and any job
 * with no attributable principal) simply lacks the key, and the worker treats
 * that as "unattributed", which is what every job did until now.
 */
export async function withTransactionalEnqueue(
  tx: DbOrTx,
  event: DomainEvent,
  job: JobSpec,
): Promise<void> {
  const principalId = job.principalId ?? currentUsageUserId();
  const payload =
    principalId && job.payload[JOB_PRINCIPAL_KEY] === undefined
      ? { ...job.payload, [JOB_PRINCIPAL_KEY]: principalId }
      : job.payload;
  await tx.insert(outboxEvent).values({ eventType: event.type, payload: event.payload });
  await tx.execute(sql`
    SELECT graphile_worker.add_job(
      ${job.type},
      payload := ${JSON.stringify(payload)}::json,
      max_attempts := ${job.maxAttempts ?? 10}
    )
  `);
}
