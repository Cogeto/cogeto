import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { MEMORY_STATUSES } from '@cogeto/shared';
import type { FactKind, MemoryScope, MemoryStatus, Principal } from '@cogeto/shared';
import { auditLog, DRIZZLE, withTransactionalEnqueue, writeAudit } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import { UserDirectory } from '../identity/index';
import { deletionReceipt, memory } from './persistence/tables';
import type { MemoryRow, SourceType } from './persistence/tables';
import type { ConfirmedReceipt } from './domain/receipt-chain';
import { buildGateFilter, MemoryVectorStore } from './persistence/vector-store';
import type { MemoryPoint } from './persistence/vector-store';
import { actorLabel, checkTransition } from './domain/transition';
import type { MemoryActor } from './domain/transition';
import { intervalHoldsAtSql } from './domain/interval';

/**
 * Public interface of the memory module (§A.1 rule 1; decision 0003 ruling 2).
 *
 * Every read REQUIRES a Principal and applies the scope and sensitive gates
 * inside the query builder — an unscoped read is unrepresentable through this
 * interface. Raw table access stays private to this module.
 *
 * Gates (hard, never score factors — §A.5 as amended by 0003 ruling 3):
 * - scope:     own rows, or rows with scope 'shared'.
 * - sensitive: excluded by default; returned ONLY to the owner, ONLY on
 *   explicit per-query opt-in.
 */

export interface NewFact {
  content: string;
  scope: MemoryScope;
  sourceType: SourceType;
  sourceId: string;
  /** Extracted entity names, flat (decision 0006 ruling 2) — the §A.5 entity signal. */
  entities?: string[];
  /** The entity this fact is primarily ABOUT (F1/F4) — distinct from mentions. */
  subjectEntity?: string;
  /** The extractor's fact kind (migration 0011) — reconciliation matches on it. */
  kind?: FactKind;
  /** Raw temporal phrases code could not resolve (decision 0007 ruling 1). */
  temporalUnresolved?: string[];
  sensitive?: boolean;
  validFrom?: Date;
  validUntil?: Date;
  /**
   * Ingestion stores unverified facts as `uncertain` (§B.3); default `active`.
   * `user_approved` exists for edit-supersession successors only (0006 ruling 3).
   */
  initialStatus?: 'active' | 'uncertain' | 'user_approved';
  /** Which embed model produced (or is about to produce) this memory's vector. */
  embeddingModel?: string;
}

export interface ReadOptions {
  /** Ruling 3: explicit opt-in; even then, only the caller's own sensitive rows. */
  includeSensitive?: boolean;
}

/** Dashboard filters (S3-B) — WHERE clauses, composed with the gates, never after them. */
export interface MemoryFilters {
  scope?: MemoryScope;
  status?: MemoryStatus;
  /** Only sensitive rows. Effective only with the includeSensitive opt-in. */
  sensitiveOnly?: boolean;
  /** Trigram-matched against the stored entities array. */
  entity?: string;
  /**
   * Owner-only (O2-B): narrows the already-gated result to the caller's OWN
   * rows, dropping the shared arm. Review uses it — you review only your own
   * uncertain facts, never a peer's shared ones (which you cannot action).
   */
  mine?: boolean;
}

export interface ListOptions extends ReadOptions, MemoryFilters {
  limit?: number;
  offset?: number;
}

export interface MemorySearchHit {
  memoryId: string;
  /** Normalized to [0,1], higher = better (research: memory-architecture §6). */
  score: number;
}

/** FTS and entity hits carry the row itself — the SQL already read it, gated. */
export interface ScoredMemory {
  memory: MemoryRow;
  /** Normalized to [0,1], higher = better. */
  score: number;
}

export interface SearchOptions extends ReadOptions {
  topK: number;
  /**
   * Reconciliation candidate narrowing (decision 0010 ruling 6) — additive
   * pre-filters ON TOP of the gates, inside the vector query, never after it:
   * exact scope, own rows only (drops the shared-scope arm of the gate), and
   * a status allowlist. Retrieval callers pass none of these.
   */
  scope?: MemoryScope;
  ownerOnly?: boolean;
  statuses?: MemoryStatus[];
}

/** ftsSearch/entitySearch accept the dashboard filters; vectorSearch does not (retrieval-only). */
export type FilteredSearchOptions = SearchOptions & MemoryFilters;

/** The job the edit path enqueues: embed the supersession successor (worker). */
export const MEMORY_EMBED_JOB_TYPE = 'memory.embed';

// ── Temporal read contracts (decision 0012) ──────────────────────────────────

/** SQL-first temporal candidate cap; Qdrant only ranks within it (ruling 3). */
const TEMPORAL_CANDIDATE_CAP = 200;

/** Audit actions that appear as change events (ruling 4) — frozen list. */
const CHANGE_STATUS_ACTIONS = [
  'memory.status_transition',
  'memory.contradiction_dismiss_restored',
  'memory.contradiction_lifted',
] as const;
const CHANGE_SUPERSEDE_ACTIONS = ['memory.superseded', 'memory.merged'] as const;

export interface PointInTimeOptions extends ReadOptions {
  topK: number;
  /** Query embedding for relevance ranking within the temporal set. */
  embedding?: number[];
  /** Optional entity narrowing (trigram, same construction as entitySearch). */
  entities?: string[];
}

export interface PointInTimeHit {
  memory: MemoryRow;
  /** Normalized vector relevance within the candidate set; null when unranked. */
  score: number | null;
}

export type MemoryChangeKind = 'learned' | 'status_changed' | 'superseded';

export interface MemoryChange {
  kind: MemoryChangeKind;
  at: Date;
  /** The memory as it is NOW (current status, pointer) — gated read. */
  memory: MemoryRow;
  detail: {
    from?: string | null;
    to?: string | null;
    reason?: string | null;
    supersededBy?: string | null;
  };
}

@Injectable()
export class MemoryStore {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    /** Optional so pure-Postgres tests need no Qdrant; DI always provides it. */
    @Optional() private readonly vectors?: MemoryVectorStore,
    /** Org resolution for audit stamping (QS-13, decision 0025) — optional so
     * bare test/fixture constructions still work (their entries stay NULL-org;
     * detail is owner-gated regardless). DI provides it. */
    @Optional() private readonly directory?: UserDirectory,
  ) {}

  /** Org for audit stamping: the owner's org via the directory, else null. */
  private async orgFor(ownerId: string): Promise<string | undefined> {
    return (await this.directory?.orgOf(ownerId)) ?? undefined;
  }

  // ── Reads (Principal-gated) ─────────────────────────────────────────────────

  async getForPrincipal(
    principal: Principal,
    memoryId: string,
    opts: ReadOptions = {},
  ): Promise<MemoryRow | null> {
    const rows = await this.db
      .select()
      .from(memory)
      .where(and(eq(memory.id, memoryId), this.visibleTo(principal, opts)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listForPrincipal(principal: Principal, opts: ListOptions = {}): Promise<MemoryRow[]> {
    return this.db
      .select()
      .from(memory)
      .where(and(this.visibleTo(principal, opts), ...this.filterClauses(principal, opts)))
      .orderBy(desc(memory.createdAt), memory.id)
      .limit(Math.min(opts.limit ?? 50, 200))
      .offset(opts.offset ?? 0);
  }

  /**
   * A subject's memories for the time-travel view (decision 0012): rows this
   * name is ABOUT — matched against `subject_entity` (the extractor's primary
   * subject, F1/F4) OR the `entities` mentions array, both by trigram — in ANY
   * lifecycle status (the past is the point). A gated read like
   * `listForPrincipal` (same `visibleTo` gate), NOT retrieval: no scoring, no
   * temporal semantics. Ordered newest-first, capped. The `entities`-only match
   * (the dashboard filter, `entitySearch`) misses facts whose subject was
   * recorded only as `subject_entity` — which is most of them — so the timeline
   * needs both arms to find its subject at all.
   */
  async listForSubject(
    principal: Principal,
    subject: string,
    opts: ReadOptions & { limit?: number } = {},
  ): Promise<MemoryRow[]> {
    const name = subject.trim();
    if (!name) return [];
    return this.db
      .select()
      .from(memory)
      .where(
        and(
          this.visibleTo(principal, opts),
          or(
            sql`${memory.subjectEntity} % ${name}`,
            sql`EXISTS (
              SELECT 1 FROM unnest(entities) AS hit(entity)
              WHERE hit.entity % ${name}
            )`,
          )!,
        ),
      )
      .orderBy(desc(memory.createdAt), memory.id)
      .limit(Math.min(opts.limit ?? 200, 200));
  }

  /**
   * Every memory the principal may see (own + visible shared), in ANY lifecycle
   * status, for a full data export (§B.5, the Memory Passport). Paged internally
   * so the export is COMPLETE beyond the dashboard's list cap; the same
   * `visibleTo` gate as every read, so a user can only ever export what they are
   * entitled to see. `includeSensitive` returns only the caller's OWN sensitive
   * rows (never a teammate's). Ordered oldest-first for a stable export.
   */
  async listAllForPrincipal(
    principal: Principal,
    opts: ReadOptions & { pageSize?: number } = {},
  ): Promise<MemoryRow[]> {
    const pageSize = Math.min(opts.pageSize ?? 500, 1000);
    const all: MemoryRow[] = [];
    for (let offset = 0; offset < 200_000; offset += pageSize) {
      const page = (await this.db
        .select()
        .from(memory)
        .where(this.visibleTo(principal, opts))
        .orderBy(memory.createdAt, memory.id)
        .limit(pageSize)
        .offset(offset)) as MemoryRow[];
      all.push(...page);
      if (page.length < pageSize) break;
    }
    return all;
  }

  /**
   * The caller's confirmed deletion receipts, in the shape `verifyChain`
   * consumes (§B.5) — owner-scoped by the signed payload's `requested_by`, the
   * same gate the Forgotten ledger uses. Exported into a Passport, each receipt
   * stays independently verifiable against the chain and the instance key.
   */
  async confirmedReceiptsForOwner(userId: string): Promise<ConfirmedReceipt[]> {
    const rows = await this.db
      .select()
      .from(deletionReceipt)
      .where(
        and(eq(deletionReceipt.status, 'confirmed'), sql`counts_json->>'requested_by' = ${userId}`),
      )
      .orderBy(deletionReceipt.confirmedAt, deletionReceipt.id);
    return rows.map((row) => ({
      id: row.id,
      source_type: row.sourceType,
      source_id: row.sourceId,
      counts_json: row.countsJson,
      signed_at: row.signedAt?.toISOString() ?? '',
      confirmed_at: row.confirmedAt?.toISOString() ?? '',
      prev_hash: row.prevHash ?? '',
      hash: row.hash ?? '',
      signature: row.signature ?? '',
    }));
  }

  /** Total under the same gates + filters — the list's pagination and the review badge. */
  async countForPrincipal(
    principal: Principal,
    opts: ReadOptions & MemoryFilters = {},
  ): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memory)
      .where(and(this.visibleTo(principal, opts), ...this.filterClauses(principal, opts)));
    return rows[0]?.n ?? 0;
  }

  /**
   * Gated memory counts by lifecycle status — the dashboard's "memory by
   * status" visual (Post-v1 Priority 2). ONE grouped query under the same
   * `visibleTo` gate as every read: own + visible-shared rows, the caller's own
   * sensitive rows included (the owner's governance view, like the Memories
   * list). Absent statuses read as zero. Cheap and constant-size (≤6 rows).
   */
  async statusCountsForPrincipal(principal: Principal): Promise<Record<MemoryStatus, number>> {
    const rows = await this.db
      .select({ status: memory.status, n: sql<number>`count(*)::int` })
      .from(memory)
      .where(this.visibleTo(principal, { includeSensitive: true }))
      .groupBy(memory.status);
    const counts = Object.fromEntries(MEMORY_STATUSES.map((s) => [s, 0])) as Record<
      MemoryStatus,
      number
    >;
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  /**
   * Distinct sources ingested per UTC day over a BOUNDED window — the "sources
   * over the last N days" series. Gated like every read; grouped by day and
   * source type; counts DISTINCT source_id (a source, not its facts). The
   * `created_at >= since` bound is what keeps this cheap: it is a windowed
   * index scan, never the whole store. Returns raw (day, sourceType, sources)
   * rows; the caller folds source types into families and fills empty days.
   */
  async sourceDailyCountsForPrincipal(
    principal: Principal,
    days: number,
  ): Promise<Array<{ day: string; sourceType: string; sources: number }>> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${memory.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        sourceType: memory.sourceType,
        sources: sql<number>`count(distinct ${memory.sourceId})::int`,
      })
      .from(memory)
      .where(
        and(this.visibleTo(principal, { includeSensitive: true }), gte(memory.createdAt, since)),
      )
      .groupBy(sql`date_trunc('day', ${memory.createdAt} AT TIME ZONE 'UTC')`, memory.sourceType);
    return rows.map((r) => ({ day: r.day, sourceType: r.sourceType, sources: r.sources }));
  }

  /**
   * The oldest unresolved uncertain fact awaiting the caller's Review, or null.
   * Owner-only (`mine`), mirroring the Review queue — you review only your own
   * uncertain facts. One aggregate query under the gates. Feeds the "oldest
   * unresolved review item age" stat together with the oldest open
   * contradiction (owned by reconciliation).
   */
  async oldestUncertainAtForPrincipal(principal: Principal): Promise<Date | null> {
    const rows = await this.db
      .select({ at: sql<Date | string | null>`min(${memory.createdAt})` })
      .from(memory)
      .where(
        and(
          this.visibleTo(principal, {}),
          eq(memory.ownerId, principal.userId),
          eq(memory.status, 'uncertain'),
        ),
      );
    // A bare aggregate can arrive as a string from the driver — normalize to Date.
    const at = rows[0]?.at ?? null;
    return at === null ? null : new Date(at);
  }

  /**
   * The supersession chain through a memory, oldest → newest (§B.2, S3-B
   * history panel): follows superseded_by forward and its inverse backward.
   * Every hop passes the same gates as any read.
   */
  async getChain(
    principal: Principal,
    memoryId: string,
    opts: ReadOptions = {},
  ): Promise<MemoryRow[]> {
    const target = await this.getForPrincipal(principal, memoryId, opts);
    if (!target) return [];
    const chain: MemoryRow[] = [target];

    // Backward: who was replaced by the head of the chain?
    for (let hops = 0; hops < 50; hops += 1) {
      const head = chain[0]!;
      const rows = await this.db
        .select()
        .from(memory)
        .where(and(eq(memory.supersededBy, head.id), this.visibleTo(principal, opts)))
        .limit(1);
      if (!rows[0]) break;
      chain.unshift(rows[0]);
    }
    // Forward: what replaced the tail?
    for (let hops = 0; hops < 50; hops += 1) {
      const tail = chain[chain.length - 1]!;
      if (!tail.supersededBy) break;
      const next = await this.getForPrincipal(principal, tail.supersededBy, opts);
      if (!next) break;
      chain.push(next);
    }
    return chain;
  }

  // ── Writes (aggregate-owned invariants) ────────────────────────────────────

  async createFromFact(principal: Principal, fact: NewFact): Promise<MemoryRow> {
    return this.db.transaction(async (tx) =>
      this.insertFact(tx, principal.userId, fact, `user:${principal.userId}`),
    );
  }

  /**
   * Admission path for the ingestion pipeline (§B.3): the verification pass
   * decides `initialStatus` (supported → active, partial/unsupported →
   * uncertain) and admits the fact inside the pipeline job's transaction, so
   * admission and the job's idempotency row commit atomically.
   */
  async admitExtractedFact(tx: Tx, ownerId: string, fact: NewFact): Promise<MemoryRow> {
    return this.insertFact(tx, ownerId, fact, 'verification');
  }

  /**
   * The single status-transition path. Legality is decided by the pure
   * checkTransition function; every transition writes an audit row in the
   * same transaction.
   */
  async transition(
    actor: MemoryActor,
    memoryId: string,
    to: MemoryStatus,
    reason?: string,
  ): Promise<MemoryRow> {
    return this.db.transaction(async (tx) => this.transitionInTx(tx, actor, memoryId, to, reason));
  }

  /**
   * The transition body, composable into a caller's transaction — how
   * reconciliation (pipeline stage 6, the contradiction resolutions) makes
   * status changes commit atomically with the relation rows and, in stage 6,
   * with the not-yet-committed incoming facts (decision 0010 ruling 1).
   *
   * `reason` is advisory context for the CALLER only and is deliberately NOT
   * persisted (QS-1, decision 0025): it can be model free-text naming private
   * memory values, and the audit trail is org-readable and outlives deletion.
   * Durable explanations live on owner-gated domain rows instead
   * (memory_relation.reason, verification_result.reason).
   */
  async transitionInTx(
    tx: Tx,
    actor: MemoryActor,
    memoryId: string,
    to: MemoryStatus,
    _reason?: string,
    /**
     * When false, the Qdrant payload sync is DEFERRED to the caller (QS-27):
     * the caller collects the id and batches setPayload after the transaction
     * commits, via {@link syncStatusPayloads}, so a bulk transition never holds
     * row locks across per-row Qdrant HTTP calls. Defaults to true — the single
     * transition still keeps the two stores honest in one act.
     */
    opts: { syncPayload?: boolean } = {},
  ): Promise<MemoryRow> {
    const row = await this.lockRow(tx, memoryId, actor);
    const check = checkTransition(row.status, to, actor);
    if (!check.allowed) {
      throw new BadRequestException(`illegal transition ${row.status} -> ${to}: ${check.reason}`);
    }
    const [updated] = await tx
      .update(memory)
      .set({ status: to, updatedAt: new Date() })
      .where(eq(memory.id, memoryId))
      .returning();
    await writeAudit(tx, {
      actor: actorLabel(actor),
      action: 'memory.status_transition',
      entityType: 'memory',
      entityId: memoryId,
      detail: { from: row.status, to },
      ownerId: row.ownerId,
      orgId: await this.orgFor(row.ownerId),
    });
    // Keep the Qdrant payload copy honest (§A.4), point op last: a failure
    // rolls the row back and the caller retries — the two stores converge.
    // requireVectors, exactly like the toggles (QS-26): a store wired without
    // Qdrant must throw here, never silently leave the point saying 'active'.
    if (opts.syncPayload !== false) {
      await this.requireVectors().setPayload(memoryId, { status: to });
    }
    return updated as MemoryRow;
  }

  /**
   * Batch the Qdrant `status` payload sync for already-committed transitions
   * (QS-27) — the deferred half of a `transitionInTx({ syncPayload: false })`
   * bulk change. Runs AFTER the caller's transaction commits, so no row lock is
   * held while these HTTP calls fan out. Idempotent (setPayload no-ops on a
   * not-yet-embedded point); the nightly payload-consistency sweep (decision
   * 0025) reconciles anything a transient Qdrant failure here leaves stale.
   */
  async syncStatusPayloads(memoryIds: string[], status: MemoryStatus): Promise<void> {
    const vectors = this.requireVectors();
    for (const id of memoryIds) {
      await vectors.setPayload(id, { status });
    }
  }

  /**
   * Bulk "mark outdated" for an owner's own memories — the effect behind the
   * approved bulk action (O1-B §3), run inside the approval executor's job
   * transaction. The Memory aggregate owns the eligibility rules (§A.1 rule 4):
   *
   * - foreign rows (owner_id ≠ ownerId) are skipped, never touched (defence in
   *   depth — the approval was authorized against the owner at create time);
   * - `user_approved` is skipped — a blanket action does not override an
   *   explicit per-memory blessing (prompt §3);
   * - `replaced` (terminal) and already-`outdated` rows are skipped as no-ops;
   * - everything else transitions to `outdated` via the single transition path
   *   (one audit row each), as the user actor (an allowed setter of outdated).
   *
   * Reversible: the owner can re-affirm any of these (outdated → active).
   *
   * Qdrant is NOT touched here (QS-27): the transitions run PG-only and the
   * caller batches the payload sync for `changed` AFTER the transaction commits
   * (via {@link syncStatusPayloads}), so this loop never holds up to 500 row
   * locks across 500 sequential Qdrant HTTP calls. The nightly payload sweep
   * (decision 0025) is the backstop if that deferred sync misses one.
   */
  async bulkMarkOutdatedForOwner(
    tx: Tx,
    ownerId: string,
    memoryIds: string[],
    reason?: string,
  ): Promise<{ changed: string[]; skipped: Array<{ id: string; reason: string }> }> {
    const actor: MemoryActor = { kind: 'user', userId: ownerId };
    const changed: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    // Deduplicate to keep the effect deterministic under a repeated id.
    for (const id of [...new Set(memoryIds)]) {
      const rows = await tx.select().from(memory).where(eq(memory.id, id)).for('update');
      const row = rows[0];
      if (!row || row.ownerId !== ownerId) {
        skipped.push({ id, reason: 'not_found_or_foreign' });
        continue;
      }
      if (row.status === 'user_approved') {
        skipped.push({ id, reason: 'user_approved' });
        continue;
      }
      if (row.status === 'replaced') {
        skipped.push({ id, reason: 'replaced' });
        continue;
      }
      if (row.status === 'outdated') {
        skipped.push({ id, reason: 'already_outdated' });
        continue;
      }
      await this.transitionInTx(tx, actor, id, 'outdated', reason ?? 'approved bulk action', {
        syncPayload: false,
      });
      changed.push(id);
    }
    return { changed, skipped };
  }

  /**
   * Sensitive is a hard gate (0003 ruling 3) — its payload copy in Qdrant must
   * change in the same act as the row. Two-store pattern (S2-B): row update +
   * audit in the transaction, the point payload write last; a failed payload
   * write rolls everything back and a retry converges (setPayload is
   * idempotent; a not-yet-embedded memory has no point and that is a no-op).
   */
  async toggleSensitive(
    principal: Principal,
    memoryId: string,
    sensitive: boolean,
  ): Promise<MemoryRow> {
    const actor: MemoryActor = { kind: 'user', userId: principal.userId };
    return this.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, memoryId, actor);
      if (row.sensitive === sensitive) return row; // idempotent no-op, no audit noise
      const [updated] = await tx
        .update(memory)
        .set({ sensitive, updatedAt: new Date() })
        .where(eq(memory.id, memoryId))
        .returning();
      await writeAudit(tx, {
        actor: actorLabel(actor),
        action: 'memory.sensitive_toggled',
        entityType: 'memory',
        entityId: memoryId,
        detail: { sensitive },
        ownerId: row.ownerId,
        orgId: principal.orgId,
      });
      await this.requireVectors().setPayload(memoryId, { sensitive });
      return updated as MemoryRow;
    });
  }

  /**
   * Scope change (O2-B) — the private↔shared visibility switch, owner-only and
   * audited, in the SAME two-store pattern as the sensitive toggle: the row and
   * the Qdrant payload's `scope` field move together, so a shared→private demote
   * takes effect in vector search the instant it commits (a demoted leak is
   * still a leak — AGENTS.md §A.4). setPayload runs last: if it throws the row
   * write rolls back and the retry converges. Task visibility follows the
   * memory — the tasks engine gates its shared arm through the deriving memory's
   * readability, and re-syncs task.scope on its next pass.
   */
  async setScope(principal: Principal, memoryId: string, scope: MemoryScope): Promise<MemoryRow> {
    const actor: MemoryActor = { kind: 'user', userId: principal.userId };
    return this.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, memoryId, actor);
      if (row.scope === scope) return row; // idempotent no-op, no audit noise
      const [updated] = await tx
        .update(memory)
        .set({ scope, updatedAt: new Date() })
        .where(eq(memory.id, memoryId))
        .returning();
      await writeAudit(tx, {
        actor: actorLabel(actor),
        action: 'memory.scope_changed',
        entityType: 'memory',
        entityId: memoryId,
        detail: { from: row.scope, to: scope },
        ownerId: row.ownerId,
        orgId: principal.orgId,
      });
      await this.requireVectors().setPayload(memoryId, { scope });
      return updated as MemoryRow;
    });
  }

  /**
   * Editing content is supersession, never mutation (0006 ruling 3): one
   * transaction creates the successor (`user_approved`, same provenance),
   * marks the predecessor `replaced`, writes the edit audit entry, and
   * enqueues the successor's embedding job via the outbox — the fast path
   * never calls the embed model. Until the worker embeds it, the successor is
   * findable via FTS/entity; vector search catches up within seconds.
   */
  async editContent(
    principal: Principal,
    memoryId: string,
    newContent: string,
  ): Promise<{ predecessor: MemoryRow; successor: MemoryRow }> {
    return this.db.transaction(async (tx) =>
      this.editContentInTx(tx, principal, memoryId, newContent),
    );
  }

  /**
   * The edit body, composable into a caller's transaction — the "correct both"
   * contradiction resolution (0010 ruling 3) performs two edits and resolves
   * the relation atomically through this.
   */
  async editContentInTx(
    tx: Tx,
    principal: Principal,
    memoryId: string,
    newContent: string,
  ): Promise<{ predecessor: MemoryRow; successor: MemoryRow }> {
    const actor: MemoryActor = { kind: 'user', userId: principal.userId };
    const old = await this.lockRow(tx, memoryId, actor);
    if (old.status === 'replaced') {
      throw new BadRequestException('memory is already replaced; edit its successor instead');
    }
    const result = await this.supersedeCore(tx, actor, old, {
      content: newContent,
      scope: old.scope,
      sourceType: old.sourceType,
      sourceId: old.sourceId,
      entities: old.entities,
      subjectEntity: old.subjectEntity ?? undefined,
      kind: old.kind ?? undefined,
      sensitive: old.sensitive,
      validUntil: old.validUntil ?? undefined,
      initialStatus: 'user_approved',
    });
    await writeAudit(tx, {
      actor: actorLabel(actor),
      action: 'memory.edited',
      entityType: 'memory',
      entityId: memoryId,
      detail: { successor: result.successor.id },
      ownerId: old.ownerId,
      orgId: principal.orgId,
    });
    await withTransactionalEnqueue(
      tx,
      {
        type: 'memory.edited',
        payload: { memory_id: memoryId, successor_id: result.successor.id },
      },
      {
        type: MEMORY_EMBED_JOB_TYPE,
        payload: { source_type: 'memory', source_id: result.successor.id },
      },
    );
    return result;
  }

  /**
   * Review rejection (0006 ruling 4): an audited removal of the row and its
   * Qdrant point through this guarded path — the narrow extension of "only
   * the saga hard-deletes". Legal ONLY from `uncertain`; owner-only. Ordering
   * makes it converge: the point is deleted before the row-delete commits, so
   * a failed point delete rolls the row back and the retry repeats both.
   * Returns null when the memory does not exist (already rejected — done).
   */
  async rejectUncertain(principal: Principal, memoryId: string): Promise<MemoryRow | null> {
    const actor: MemoryActor = { kind: 'user', userId: principal.userId };
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(memory).where(eq(memory.id, memoryId)).for('update');
      const row = rows[0];
      if (!row) return null;
      if (actor.kind === 'user' && row.ownerId !== actor.userId) {
        throw new NotFoundException(`memory ${memoryId} not found`);
      }
      if (row.status !== 'uncertain') {
        throw new BadRequestException(
          `only an uncertain memory can be rejected in review (this one is ${row.status}); ` +
            'source-level deletion goes through the deletion saga (§A.7)',
        );
      }
      await tx.delete(memory).where(eq(memory.id, memoryId));
      await writeAudit(tx, {
        actor: actorLabel(actor),
        action: 'memory.rejected',
        entityType: 'memory',
        entityId: memoryId,
        detail: { sourceType: row.sourceType, sourceId: row.sourceId, status: row.status },
        ownerId: row.ownerId,
        orgId: principal.orgId,
      });
      await this.requireVectors().deletePoints([memoryId]);
      return row;
    });
  }

  /**
   * Supersession (§B.2): the ONLY path to `replaced`. Creates the successor,
   * closes the predecessor's validity interval, points superseded_by at the
   * successor — never deletes history.
   */
  async supersede(
    actor: MemoryActor,
    predecessorId: string,
    successorFact: NewFact,
  ): Promise<{ predecessor: MemoryRow; successor: MemoryRow }> {
    return this.db.transaction(async (tx) =>
      this.supersedeInTx(tx, actor, predecessorId, successorFact),
    );
  }

  /**
   * The supersession body, composable into a caller's transaction — how the
   * reconciliation merge enriches a survivor atomically with the merge itself
   * (decision 0010 ruling 4).
   */
  async supersedeInTx(
    tx: Tx,
    actor: MemoryActor,
    predecessorId: string,
    successorFact: NewFact,
  ): Promise<{ predecessor: MemoryRow; successor: MemoryRow }> {
    if (actor.kind !== 'user' && actor.kind !== 'reconciliation') {
      throw new BadRequestException('only the user or reconciliation may supersede a memory');
    }
    const old = await this.lockRow(tx, predecessorId, actor);
    if (old.status === 'replaced') {
      throw new BadRequestException('memory is already replaced; supersede its successor');
    }
    return this.supersedeCore(tx, actor, old, successorFact);
  }

  /** Shared body of supersede/editContent: caller holds the lock and the tx. */
  private async supersedeCore(
    tx: Tx,
    actor: MemoryActor,
    old: MemoryRow,
    successorFact: NewFact,
  ): Promise<{ predecessor: MemoryRow; successor: MemoryRow }> {
    const successorValidFrom = successorFact.validFrom ?? new Date();
    const successor = await this.insertFact(
      tx,
      old.ownerId,
      { ...successorFact, validFrom: successorValidFrom },
      actorLabel(actor),
    );
    const [predecessor] = await tx
      .update(memory)
      .set({
        status: 'replaced',
        validUntil: successorValidFrom,
        supersededBy: successor.id,
        updatedAt: new Date(),
      })
      .where(eq(memory.id, old.id))
      .returning();
    await writeAudit(tx, {
      actor: actorLabel(actor),
      action: 'memory.superseded',
      entityType: 'memory',
      entityId: old.id,
      detail: { supersededBy: successor.id, validUntil: successorValidFrom.toISOString() },
      ownerId: old.ownerId,
      orgId: await this.orgFor(old.ownerId),
    });
    // Payload copy honesty (§A.4): the predecessor's point now says replaced.
    // requireVectors like the toggles (QS-26) — never a silent skip.
    await this.requireVectors().setPayload(old.id, { status: 'replaced' });
    return { predecessor: predecessor as MemoryRow, successor };
  }

  // ── Search primitives (0003 ruling 2: Principal-gated, gates in the store) ──

  /**
   * Semantic search over the Qdrant index. The scope and sensitive gates are
   * native payload pre-filters INSIDE the vector query (§A.4/§A.5) — an
   * ungated hit cannot exist, not even transiently. Scores are normalized to
   * [0,1], higher = better (cosine similarity mapped from [-1,1]).
   */
  async vectorSearch(
    principal: Principal,
    embedding: number[],
    opts: SearchOptions,
  ): Promise<MemorySearchHit[]> {
    const filter = buildGateFilter(principal, opts);
    // Candidate narrowing (0010 ruling 6): extra must-conditions AND with the
    // gates — they can only shrink the result, never widen past a gate.
    if (opts.scope) filter.must.push({ key: 'scope', match: { value: opts.scope } });
    if (opts.ownerOnly) filter.must.push({ key: 'owner_id', match: { value: principal.userId } });
    if (opts.statuses?.length) {
      filter.must.push({ key: 'status', match: { any: [...opts.statuses] } });
    }
    const hits = await this.requireVectors().search(embedding, filter, opts.topK);
    return hits.map((hit) => ({
      memoryId: hit.id,
      score: Math.min(1, Math.max(0, (hit.score + 1) / 2)),
    }));
  }

  /**
   * Keyword full-text search over the generated content_tsv column (migration
   * 0005; decision 0006 ruling 1: simple config + unaccent). The scope and
   * sensitive gates are WHERE clauses in the same query — no post-filtering.
   * Scores are ts_rank_cd with normalization 32 (rank/(rank+1)), i.e. [0,1).
   */
  async ftsSearch(
    principal: Principal,
    query: string,
    opts: FilteredSearchOptions,
  ): Promise<ScoredMemory[]> {
    if (!query.trim()) return [];
    const tsQuery = sql`websearch_to_tsquery('simple', cogeto_unaccent(${query}))`;
    const score = sql<number>`ts_rank_cd(content_tsv, ${tsQuery}, 32)`;
    const rows = await this.db
      .select({ memory, score })
      .from(memory)
      .where(
        and(
          this.visibleTo(principal, opts),
          sql`content_tsv @@ ${tsQuery}`,
          ...this.filterClauses(principal, opts),
        ),
      )
      .orderBy(desc(score), memory.id)
      .limit(opts.topK);
    return rows.map((row) => ({ memory: row.memory, score: Number(row.score) }));
  }

  /**
   * Trigram entity match (decision 0006 ruling 2): query names against the
   * entities array, fuzzy via pg_trgm's % operator (its similarity threshold),
   * gated exactly like every other read. Score = best similarity between any
   * stored entity and any queried name, already in [0,1].
   */
  async entitySearch(
    principal: Principal,
    names: string[],
    opts: FilteredSearchOptions,
  ): Promise<ScoredMemory[]> {
    const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
    if (wanted.length === 0) return [];
    const namesArray = sql`ARRAY[${sql.join(
      wanted.map((name) => sql`${name}`),
      sql`, `,
    )}]::text[]`;
    const score = sql<number>`(
      SELECT max(similarity(hit.entity, wanted.name))
      FROM unnest(entities) AS hit(entity), unnest(${namesArray}) AS wanted(name)
    )`;
    const rows = await this.db
      .select({ memory, score })
      .from(memory)
      .where(
        and(
          this.visibleTo(principal, opts),
          sql`EXISTS (
            SELECT 1 FROM unnest(entities) AS hit(entity), unnest(${namesArray}) AS wanted(name)
            WHERE hit.entity % wanted.name
          )`,
          ...this.filterClauses(principal, opts),
        ),
      )
      .orderBy(desc(score), memory.id)
      .limit(opts.topK);
    return rows.map((row) => ({ memory: row.memory, score: Number(row.score) }));
  }

  /**
   * Gated batch read — how retrieval resolves vectorSearch's id hits into rows.
   * Same gates as every read; ids the principal may not see simply drop out.
   */
  async getManyForPrincipal(
    principal: Principal,
    memoryIds: string[],
    opts: ReadOptions = {},
  ): Promise<MemoryRow[]> {
    if (memoryIds.length === 0) return [];
    return this.db
      .select()
      .from(memory)
      .where(and(inArray(memory.id, memoryIds), this.visibleTo(principal, opts)));
  }

  /**
   * A source's derived memories, summarized for the connectors' source drawer —
   * the owner (authorization), the inherited scope/sensitive, and the earliest
   * createdAt. Null when the source has no memories. Used for discarded files,
   * whose byte-less original left no file_metadata but whose memories still
   * carry the source key as provenance (F1 handoff §3).
   */
  async describeSource(
    sourceType: SourceType,
    sourceId: string,
  ): Promise<{ ownerId: string; scope: MemoryScope; sensitive: boolean; createdAt: Date } | null> {
    const rows = await this.db
      .select({
        ownerId: memory.ownerId,
        scope: memory.scope,
        sensitive: memory.sensitive,
        createdAt: memory.createdAt,
      })
      .from(memory)
      .where(and(eq(memory.sourceType, sourceType), eq(memory.sourceId, sourceId)))
      .orderBy(memory.createdAt)
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Temporal primitives (decision 0012; §A.5 temporal lift, §B.2) ──────────

  /**
   * Facts holding at instant t — in ANY lifecycle status (replaced and
   * outdated included: they are the point of the query), each with its
   * current status and superseded_by pointer so answers frame past belief
   * honestly. Gates unchanged: temporal never weakens scope or sensitive.
   *
   * Candidates come from SQL FIRST via the shared interval predicate — the
   * NULL semantics (created_at fallback, open valid_until) are Postgres
   * truth that the Qdrant payload cannot express (ruling 3). The vector
   * index participates only to rank relevance WITHIN that candidate set.
   */
  async pointInTime(
    principal: Principal,
    t: Date,
    opts: PointInTimeOptions,
  ): Promise<PointInTimeHit[]> {
    const base: SQL[] = [this.visibleTo(principal, opts), intervalHoldsAtSql(t)];
    const fetch = (clauses: SQL[]) =>
      this.db
        .select()
        .from(memory)
        .where(and(...clauses))
        .orderBy(desc(sql`COALESCE(${memory.validFrom}, ${memory.createdAt})`), memory.id)
        .limit(TEMPORAL_CANDIDATE_CAP);

    // Entity narrowing is a NARROWING, never a recall killer: query-side
    // entity heuristics ("CRM", a month name) often miss the stored names, so
    // an empty narrowed set falls back to the full temporal set — relevance
    // ranking below does the rest. Gates are in `base` either way.
    let candidates: Awaited<ReturnType<typeof fetch>> = [];
    const wanted = [...new Set((opts.entities ?? []).map((n) => n.trim()).filter(Boolean))];
    if (wanted.length > 0) {
      const namesArray = sql`ARRAY[${sql.join(
        wanted.map((name) => sql`${name}`),
        sql`, `,
      )}]::text[]`;
      candidates = await fetch([
        ...base,
        sql`EXISTS (
          SELECT 1 FROM unnest(entities) AS hit(entity), unnest(${namesArray}) AS wanted(name)
          WHERE hit.entity % wanted.name
        )`,
      ]);
    }
    if (candidates.length === 0) candidates = await fetch(base);

    // Relevance ranking within the temporal set (never a wider set).
    let scores = new Map<string, number>();
    if (opts.embedding && candidates.length > 0) {
      const hits = await this.vectorSearch(principal, opts.embedding, {
        topK: TEMPORAL_CANDIDATE_CAP,
        includeSensitive: opts.includeSensitive,
      });
      scores = new Map(hits.map((h) => [h.memoryId, h.score]));
    }
    return candidates
      .map((row) => ({ memory: row as MemoryRow, score: scores.get(row.id) ?? null }))
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
      .slice(0, opts.topK);
  }

  /**
   * What changed since `since`, for the caller's visible memories: the exact
   * event set of decision 0012 ruling 4 — learned / status_changed /
   * superseded — newest first. Erased memories resolve to no row and produce
   * no event (their ledger is the Forgotten section, §B.1).
   */
  async changesSince(
    principal: Principal,
    since: Date,
    opts: ReadOptions & { limit?: number } = {},
  ): Promise<MemoryChange[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const events: MemoryChange[] = [];

    const learned = await this.db
      .select()
      .from(memory)
      .where(and(this.visibleTo(principal, opts), gte(memory.createdAt, since)))
      .orderBy(desc(memory.createdAt), memory.id)
      .limit(limit);
    for (const row of learned) {
      events.push({ kind: 'learned', at: row.createdAt, memory: row as MemoryRow, detail: {} });
    }

    const auditRows = await this.db
      .select()
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.action, [...CHANGE_STATUS_ACTIONS, ...CHANGE_SUPERSEDE_ACTIONS]),
          eq(auditLog.entityType, 'memory'),
          gte(auditLog.createdAt, since),
          // QS-31: restrict to the caller's OWN memory events BEFORE the limit.
          // Without this the query scans all owners' events and, on a busy
          // instance, another owner's changes push the caller's out of the
          // window — silently missing from "what changed since". Memory
          // status/supersede audit rows are always stamped with the memory
          // owner's id (never null), so ownership = visibility here (v1 notes
          // are private; the getManyForPrincipal re-check below still enforces
          // the scope + sensitive gates as defence in depth).
          eq(auditLog.ownerId, principal.userId),
        ),
      )
      .orderBy(desc(auditLog.createdAt), auditLog.id)
      .limit(limit * 2);
    const visible = new Map(
      (
        await this.getManyForPrincipal(
          principal,
          [...new Set(auditRows.map((row) => row.entityId))],
          opts,
        )
      ).map((row) => [row.id, row]),
    );
    for (const row of auditRows) {
      const target = visible.get(row.entityId);
      if (!target) continue; // other owners' or erased memories: no event
      const detail = (row.detailJson ?? {}) as Record<string, unknown>;
      if ((CHANGE_SUPERSEDE_ACTIONS as readonly string[]).includes(row.action)) {
        events.push({
          kind: 'superseded',
          at: row.createdAt,
          memory: target,
          detail: {
            supersededBy:
              (detail['supersededBy'] as string | undefined) ??
              (detail['survivor'] as string | undefined) ??
              target.supersededBy ??
              null,
            reason: (detail['reason'] as string | undefined) ?? null,
          },
        });
      } else {
        events.push({
          kind: 'status_changed',
          at: row.createdAt,
          memory: target,
          detail: {
            from: (detail['from'] as string | undefined) ?? null,
            to: (detail['to'] as string | undefined) ?? target.status,
            reason: (detail['reason'] as string | undefined) ?? null,
          },
        });
      }
    }

    return events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
  }

  // ── Vector index maintenance (memory owns the Qdrant client — ruling 2) ────

  /** Idempotent collection + payload-index creation; runs on worker boot. */
  async ensureIndexReady(): Promise<void> {
    await this.requireVectors().ensureCollection();
  }

  /**
   * Writes the Qdrant points for already-committed (or about-to-commit) rows.
   * Point id = memory id, so retries upsert instead of duplicating; callers
   * (pipeline stage 5, reindex) order this AFTER the Postgres writes.
   */
  async upsertVectors(rows: MemoryRow[], embeddings: number[][]): Promise<void> {
    if (rows.length !== embeddings.length) {
      throw new BadRequestException(
        `got ${embeddings.length} embeddings for ${rows.length} memories`,
      );
    }
    const points: MemoryPoint[] = rows.map((row, i) => ({
      id: row.id,
      vector: embeddings[i]!,
      payload: {
        owner_id: row.ownerId,
        scope: row.scope,
        status: row.status,
        sensitive: row.sensitive,
        source_type: row.sourceType,
        source_id: row.sourceId,
        valid_until: row.validUntil?.toISOString() ?? null,
      },
    }));
    await this.requireVectors().upsert(points);
  }

  /**
   * Stored embeddings by memory id — how the dreaming batch driver rebuilds
   * ReconcileInputs without re-embedding (decision 0011). Ids the caller
   * holds already passed a gated read; rows never embedded simply drop out.
   */
  async retrieveEmbeddings(memoryIds: string[]): Promise<Map<string, number[]>> {
    if (memoryIds.length === 0) return new Map();
    return this.requireVectors().retrieveVectors(memoryIds);
  }

  // ── System reads for the dreaming driver (decision 0011) ───────────────────
  // Worker-only machine reads, the out-of-module mirror of the sweep's
  // in-module scans: no Principal because the caller is the nightly job
  // covering every owner. They feed reconciliation, whose candidate reads and
  // actions re-apply the per-owner gates; nothing here reaches a user.

  /** The day's scope: rows admitted or touched inside the watermark window. */
  async listTouchedBetween(from: Date, to: Date, limit = 2000): Promise<MemoryRow[]> {
    return this.db
      .select()
      .from(memory)
      .where(
        and(
          inArray(memory.status, ['active', 'uncertain']),
          or(
            and(sql`${memory.createdAt} >= ${from}`, sql`${memory.createdAt} < ${to}`),
            and(sql`${memory.updatedAt} >= ${from}`, sql`${memory.updatedAt} < ${to}`),
          ),
        ),
      )
      .orderBy(memory.ownerId, memory.createdAt)
      .limit(limit);
  }

  /** Staleness pass input: active rows whose validity interval has lapsed. */
  async listLapsedActive(asOf: Date, limit = 2000): Promise<MemoryRow[]> {
    return this.db
      .select()
      .from(memory)
      .where(and(eq(memory.status, 'active'), sql`${memory.validUntil} < ${asOf}`))
      .orderBy(memory.createdAt)
      .limit(limit);
  }

  /** Dormant pass input: active commitments with no activity since the window. */
  async listQuietCommitments(quietBefore: Date, limit = 2000): Promise<MemoryRow[]> {
    return this.db
      .select()
      .from(memory)
      .where(
        and(
          eq(memory.status, 'active'),
          eq(memory.kind, 'commitment'),
          sql`${memory.createdAt} < ${quietBefore}`,
          sql`${memory.updatedAt} < ${quietBefore}`,
        ),
      )
      .orderBy(memory.createdAt)
      .limit(limit);
  }

  /** Batch system read — flag maintenance resolves current statuses through it. */
  async getManySystem(memoryIds: string[]): Promise<MemoryRow[]> {
    if (memoryIds.length === 0) return [];
    return this.db.select().from(memory).where(inArray(memory.id, memoryIds));
  }

  /** A source's derived memories — the task engine's derivation input (0013 r2). */
  async listBySourceSystem(sourceType: SourceType, sourceId: string): Promise<MemoryRow[]> {
    return this.db
      .select()
      .from(memory)
      .where(and(eq(memory.sourceType, sourceType), eq(memory.sourceId, sourceId)))
      .orderBy(memory.createdAt, memory.id);
  }

  /** Kind/status scan — the task backfill's input (0013 ruling 2). */
  async listByKindsSystem(
    kinds: FactKind[],
    statuses: MemoryStatus[],
    limit = 2000,
  ): Promise<MemoryRow[]> {
    if (kinds.length === 0 || statuses.length === 0) return [];
    return this.db
      .select()
      .from(memory)
      .where(and(inArray(memory.kind, kinds), inArray(memory.status, statuses)))
      .orderBy(memory.createdAt, memory.id)
      .limit(limit);
  }

  private requireVectors(): MemoryVectorStore {
    if (!this.vectors) {
      throw new NotImplementedException(
        'MemoryStore was constructed without a vector store (Qdrant) — register MemoryModule with a qdrantUrl',
      );
    }
    return this.vectors;
  }

  // ── Private: the gates and shared write paths ───────────────────────────────

  /** Dashboard filters as SQL — always ANDed with the gates, never a substitute. */
  private filterClauses(principal: Principal, filters: MemoryFilters): SQL[] {
    const clauses: SQL[] = [];
    if (filters.mine) clauses.push(eq(memory.ownerId, principal.userId));
    if (filters.scope) clauses.push(eq(memory.scope, filters.scope));
    if (filters.status) clauses.push(eq(memory.status, filters.status));
    if (filters.sensitiveOnly) clauses.push(eq(memory.sensitive, true));
    if (filters.entity?.trim()) {
      clauses.push(
        sql`EXISTS (
          SELECT 1 FROM unnest(entities) AS hit(entity)
          WHERE hit.entity % ${filters.entity.trim()}
        )`,
      );
    }
    return clauses;
  }

  /** The scope + sensitive gates. Private: every public read builds on this. */
  private visibleTo(principal: Principal, opts: ReadOptions): SQL {
    const scopeGate = or(eq(memory.ownerId, principal.userId), eq(memory.scope, 'shared'))!;
    const sensitiveGate = opts.includeSensitive
      ? or(eq(memory.sensitive, false), eq(memory.ownerId, principal.userId))!
      : eq(memory.sensitive, false);
    return and(scopeGate, sensitiveGate)!;
  }

  private async insertFact(
    tx: Tx,
    ownerId: string,
    fact: NewFact,
    actor: string,
  ): Promise<MemoryRow> {
    // Provenance is NOT NULL, always (§A.6): the aggregate rejects orphans even
    // where the database could not (an empty string satisfies a NOT NULL column).
    if (!ownerId.trim() || !fact.sourceType || !fact.sourceId.trim()) {
      throw new BadRequestException(
        'a memory requires owner_id, source_type and source_id — no orphans, ever (§A.6)',
      );
    }
    const [row] = await tx
      .insert(memory)
      .values({
        ownerId,
        scope: fact.scope,
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
        status: fact.initialStatus ?? 'active',
        sensitive: fact.sensitive ?? false,
        entities: fact.entities ?? [],
        subjectEntity: fact.subjectEntity,
        kind: fact.kind,
        temporalUnresolved: fact.temporalUnresolved ?? [],
        validFrom: fact.validFrom ?? new Date(),
        validUntil: fact.validUntil,
        content: fact.content,
        embeddingModel: fact.embeddingModel,
      })
      .returning();
    const created = row as MemoryRow;
    await writeAudit(tx, {
      actor,
      action: 'memory.created',
      entityType: 'memory',
      entityId: created.id,
      detail: { sourceType: fact.sourceType, sourceId: fact.sourceId, scope: fact.scope },
      ownerId,
      orgId: await this.orgFor(ownerId),
    });
    return created;
  }

  /**
   * Locks the row for the write. User actors may only touch rows they own —
   * reported as NotFound so the API does not leak the existence of other
   * users' memories.
   */
  private async lockRow(tx: Tx, memoryId: string, actor: MemoryActor): Promise<MemoryRow> {
    const rows = await tx.select().from(memory).where(eq(memory.id, memoryId)).for('update');
    const row = rows[0];
    if (!row || (actor.kind === 'user' && row.ownerId !== actor.userId)) {
      throw new NotFoundException(`memory ${memoryId} not found`);
    }
    return row;
  }
}
