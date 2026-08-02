import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { auditLog } from './persistence/tables';

export interface AuditEntry {
  /** e.g. `user:<id>`, `reconciliation`, `verification`, `deletion_saga`, `worker:echo` */
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  /**
   * STRUCTURAL METADATA ONLY: ids, kinds, transition
   * names, counts, booleans. Never memory/note/chat content, never model
   * free-text (reasons, excerpts, slot values) — those belong on owner-gated
   * domain rows (verification_result.reason, memory_relation.reason). The
   * audit trail is org-readable and append-only: content written here
   * outlives deletion and leaks across users.
   */
  detail?: Record<string, unknown>;
  /** Zitadel org for org-scoped audit reads (spec §4.2). NULL = system/global entry. */
  orgId?: string;
  /**
   * The user whose artifact this entry concerns.
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

/** One row as the trail stores it — what {@link readAuditEntries} returns. */
export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: Record<string, unknown> | null;
  orgId: string | null;
  ownerId: string | null;
  createdAt: Date;
}

/**
 * The narrow read side of the trail (boundary contract §2).
 *
 * `audit_log` is infrastructure's table: every context appends to it and none
 * owns it. Before this existed the table object itself was re-exported from the
 * barrel, so memory, agents and passport each ran their own SELECT against a
 * table they do not own and the persistence rule saw a legal barrel import
 * (spec §15.2). This is the one place the table is read.
 *
 * Deliberately not a query builder: a filter of exactly the predicates the
 * domain modules ask for. The instance-wide audit endpoint's `ILIKE` filtering
 * stays where it is until part 2 (recorded exception B8).
 */
export async function readAuditEntries(
  executor: DbOrTx,
  filter: {
    /** Match any of these `action` values. */
    actions: readonly string[];
    entityType?: string;
    /** Restrict to entries about these entity ids. */
    entityIds?: readonly string[];
    /** Restrict to entries about this owner's artifacts. */
    ownerId?: string;
    /** Inclusive lower bound on `created_at`. */
    since?: Date;
    limit?: number;
  },
): Promise<AuditRecord[]> {
  if (filter.actions.length === 0) return [];
  if (filter.entityIds?.length === 0) return [];
  const where = [
    inArray(auditLog.action, [...filter.actions]),
    ...(filter.entityType ? [eq(auditLog.entityType, filter.entityType)] : []),
    ...(filter.entityIds ? [inArray(auditLog.entityId, [...filter.entityIds])] : []),
    ...(filter.ownerId ? [eq(auditLog.ownerId, filter.ownerId)] : []),
    ...(filter.since ? [gte(auditLog.createdAt, filter.since)] : []),
  ];
  // Newest first, id as the tiebreak — the strongest of the orderings the call
  // sites used, so no caller's result set can change.
  const query = executor
    .select()
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.createdAt), asc(auditLog.id));
  const rows = await (filter.limit === undefined ? query : query.limit(filter.limit));
  return rows.map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    detail: (row.detailJson ?? null) as Record<string, unknown> | null,
    orgId: row.orgId,
    ownerId: row.ownerId,
    createdAt: row.createdAt,
  }));
}
