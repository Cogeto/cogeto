import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
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
  /**
   * The space the audited action happened in (docs/features/spaces.md,
   * session 2): request paths pass the principal's resolved space, worker
   * paths the subject row's. An ATTRIBUTE for filtering, never a gate — the
   * trail stays ONE instance-level, administrator-only surface (issue #633).
   * Absent = a genuinely instance-level action (provider configuration, user
   * erasure, sweeps, instance-wide passes), never "unknown".
   */
  spaceId?: string;
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
    spaceId: entry.spaceId ?? null,
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
  spaceId: string | null;
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
 * domain modules ask for. The instance-wide browse is {@link readAuditPage}.
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
    /**
     * Restrict to entries stamped with this space, PLUS unstamped ones
     * (docs/features/spaces.md, session 2). Unstamped rows ride along because
     * a NULL space marks an instance-level entry or one written before the
     * attribute existed, and a limit-bounded caller (the change feed) must
     * not lose those to the filter while still keeping another space's
     * entries from consuming its window.
     */
    spaceId?: string;
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
    ...(filter.spaceId
      ? [or(eq(auditLog.spaceId, filter.spaceId), isNull(auditLog.spaceId))!]
      : []),
  ];
  // Newest first, id as the tiebreak — the strongest of the orderings the call
  // sites used, so no caller's result set can change.
  const query = executor
    .select()
    .from(auditLog)
    .where(and(...where))
    .orderBy(desc(auditLog.createdAt), asc(auditLog.id));
  const rows = await (filter.limit === undefined ? query : query.limit(filter.limit));
  return rows.map(toRecord);
}

/** The one row shape both readers hand back: the stored row, nothing derived. */
function toRecord(row: typeof auditLog.$inferSelect): AuditRecord {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    detail: (row.detailJson ?? null) as Record<string, unknown> | null,
    orgId: row.orgId,
    ownerId: row.ownerId,
    spaceId: row.spaceId,
    createdAt: row.createdAt,
  };
}

/**
 * The trail's paged browse (V2.0 item 3.6 part 2). The `/api/audit` surface ran
 * this query from the composition root against a table it does not own
 * (recorded exception B8); the SQL is unchanged, it just lives with the table.
 *
 * `orgId` is not optional: the org gate is spec §4.2 and a caller sees only
 * their org's entries plus system/global (null-org) ones. Making it a required
 * argument is the point — an unscoped browse of the trail is unrepresentable
 * here, the same way unscoped memory queries are in retrieval.
 *
 * The owner gate on `detail_json` stays with the caller, which is where the
 * Principal is: this returns the rows, including `ownerId`, and the reader
 * decides what to show.
 */
export async function readAuditPage(
  executor: DbOrTx,
  filter: {
    /** The caller's org. Entries from other orgs are never returned. */
    orgId: string;
    /** Case-insensitive substring; LIKE metacharacters are matched literally. */
    actor?: string;
    action?: string;
    entityType?: string;
    /** Exact space filter (docs/features/spaces.md): only entries stamped
     * with this space. Strict on purpose — the administrator asked for one
     * space's actions, and an unstamped entry is instance-level by contract. */
    spaceId?: string;
    /** Inclusive lower bound / exclusive upper bound on `created_at`. */
    from?: Date;
    to?: Date;
    limit: number;
    offset: number;
  },
): Promise<{ rows: AuditRecord[]; total: number }> {
  const clauses: SQL[] = [
    // The org gate — never another org's entries; null-org = system/global.
    or(eq(auditLog.orgId, filter.orgId), isNull(auditLog.orgId))!,
  ];
  // Escape LIKE metacharacters so a user-supplied `%`/`_` is matched literally
  // (not as a wildcard): no match-everything, no slow leading-wildcard
  // patterns. The bound ESCAPE clause makes `\` the escape character.
  if (filter.actor)
    clauses.push(sql`${auditLog.actor} ILIKE ${`%${escapeLike(filter.actor)}%`} ESCAPE '\\'`);
  if (filter.action)
    clauses.push(sql`${auditLog.action} ILIKE ${`%${escapeLike(filter.action)}%`} ESCAPE '\\'`);
  if (filter.entityType) clauses.push(eq(auditLog.entityType, filter.entityType));
  if (filter.spaceId) clauses.push(eq(auditLog.spaceId, filter.spaceId));
  if (filter.from) clauses.push(gte(auditLog.createdAt, filter.from));
  if (filter.to) clauses.push(lt(auditLog.createdAt, filter.to));
  const where = and(...clauses);

  const [rows, totalRows] = await Promise.all([
    executor
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt))
      .limit(filter.limit)
      .offset(filter.offset),
    executor.select({ n: count() }).from(auditLog).where(where),
  ]);
  return { rows: rows.map(toRecord), total: Number(totalRows[0]?.n ?? 0) };
}

/** Escape LIKE/ILIKE metacharacters so user input matches literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
