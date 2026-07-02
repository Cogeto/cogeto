import { sql } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { outboxEvent } from './persistence/tables';

export interface DomainEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface JobSpec {
  type: string;
  /** Must carry source_type + source_id — the idempotency key (§A.3). */
  payload: { source_type: string; source_id: string } & Record<string, unknown>;
  maxAttempts?: number;
}

/**
 * Transactional enqueue — the outbox (§A.3): the domain event and its job are
 * written in the CALLER's transaction, in the same commit as the state change.
 * Nothing can be ingested and silently unprocessed; a rolled-back transaction
 * leaves neither an event nor a job.
 */
export async function withTransactionalEnqueue(
  tx: DbOrTx,
  event: DomainEvent,
  job: JobSpec,
): Promise<void> {
  await tx.insert(outboxEvent).values({ eventType: event.type, payload: event.payload });
  await tx.execute(sql`
    SELECT graphile_worker.add_job(
      ${job.type},
      payload := ${JSON.stringify(job.payload)}::json,
      max_attempts := ${job.maxAttempts ?? 10}
    )
  `);
}
