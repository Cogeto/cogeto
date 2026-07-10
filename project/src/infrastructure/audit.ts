import type { DbOrTx } from './db';
import { auditLog } from './persistence/tables';

export interface AuditEntry {
  /** e.g. `user:<id>`, `reconciliation`, `verification`, `deletion_saga`, `worker:echo` */
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  /**
   * STRUCTURAL METADATA ONLY (QS-1, decision 0025): ids, kinds, transition
   * names, counts, booleans. Never memory/note/chat content, never model
   * free-text (reasons, excerpts, slot values) — those belong on owner-gated
   * domain rows (verification_result.reason, memory_relation.reason). The
   * audit trail is org-readable and append-only: content written here
   * outlives deletion and leaks across users.
   */
  detail?: Record<string, unknown>;
  /** Zitadel org for org-scoped audit reads (§A.4). NULL = system/global entry. */
  orgId?: string;
  /**
   * The user whose artifact this entry concerns (QS-1/QS-13, decision 0025).
   * The reader returns detail_json only to this owner; NULL marks a genuine
   * system entry (sweep runs, chain confirmations) whose detail is public
   * structural metadata within the org.
   */
  ownerId?: string;
}

/**
 * Appends one audit row (append-only — a database trigger rejects UPDATE/DELETE).
 * Pass the surrounding transaction so the audit row commits with the change it records.
 */
export async function writeAudit(executor: DbOrTx, entry: AuditEntry): Promise<void> {
  await executor.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    detailJson: entry.detail ?? null,
    orgId: entry.orgId ?? null,
    ownerId: entry.ownerId ?? null,
  });
}
