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
import { isRegisteredSourceType, MEMORY_STATUSES } from '@cogeto/shared';
import type {
  FactKind,
  MemoryScope,
  MemoryStatus,
  Principal,
  UncertaintyReason,
} from '@cogeto/shared';
import {
  DRIZZLE,
  readAuditEntries,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
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
import { visibleToPrincipal } from './domain/scope-gate';

/**
 * Public interface of the memory module (spec §15 rule 1).
 *
 * Every read REQUIRES a Principal and applies the scope and sensitive gates
 * inside the query builder — an unscoped read is unrepresentable through this
 * interface. Raw table access stays private to this module.
 *
 * Gates (hard, never score factors — spec §3.4 as amended by 0003 ruling 3)
 * - scope:     own rows, or rows with scope 'shared'.
 * - sensitive: excluded by default; returned ONLY to the owner, ONLY on
 *   explicit per-query opt-in.
 */

export interface NewFact {
  content: string;
  scope: MemoryScope;
  sourceType: SourceType;
  sourceId: string;
  /** Extracted entity names, flat — the spec §3.4 entity signal. */
  entities?: string[];
  /** The entity this fact is primarily ABOUT (F1/F4) — distinct from mentions. */
  subjectEntity?: string;
  /** The extractor's fact kind (migration 0011) — reconciliation matches on it. */
  kind?: FactKind;
  /** Email-path authorship (migration 0030): true = the user's
   * own new text; false = someone else's words; omit = unknown/not applicable. */
  authoredByUser?: boolean;
  /** Raw temporal phrases code could not resolve. */
  temporalUnresolved?: string[];
  sensitive?: boolean;
  validFrom?: Date;
  validUntil?: Date;
  /**
   * Ingestion stores unverified facts as `uncertain` (spec §2); default `active`.
   * `user_approved` exists for edit-supersession successors only (0006 ruling 3).
   */
  initialStatus?: 'active' | 'uncertain' | 'user_approved';
  /**
   * WHY the fact is admitted `uncertain` (V2.0 item 3.3). Required whenever
   * `initialStatus` is `uncertain` and rejected otherwise: the admission
   * taxonomy is total, so an uncertain fact with no named reason would be the
   * fallthrough the taxonomy exists to prevent.
   */
  uncertaintyReason?: UncertaintyReason;
  /** Which embed model produced (or is about to produce) this memory's vector. */
  embeddingModel?: string;
}

export interface ReadOptions {
  /** Ruling 3: explicit opt-in; even then, only the caller's own sensitive rows. */
  includeSensitive?: boolean;
}

/** Dashboard filters — WHERE clauses, composed with the gates, never after them. */
export interface MemoryFilters {
  scope?: MemoryScope;
  status?: MemoryStatus;
  /** Only sensitive rows. Effective only with the includeSensitive opt-in. */
  sensitiveOnly?: boolean;
  /** Trigram-matched against the stored entities array. */
  entity?: string;
  /**
   * Owner-only: narrows the already-gated result to the caller's OWN
   * rows, dropping the shared arm. Review uses it — you review only your own
   * uncertain facts, never a peer's shared ones (which you cannot action).
   */
  mine?: boolean;
  /** One source's facts (V2.2 item 5.2, the source detail view). Both parts
   * or neither: an id without a type would match across types. */
  sourceType?: SourceType;
  sourceId?: string;
  /** The admission taxonomy arm (V2.2 item 5.2, the filtered fact search). */
  uncertaintyReason?: UncertaintyReason;
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
   * Reconciliation candidate narrowing — additive
   * pre-filters ON TOP of the gates, inside the vector query, never after it
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

// ── Open loops ────────────────────────────────

/** The two kinds that ARE open loops — the extractor's own labels. */
export const OPEN_LOOP_KINDS = ['commitment', 'open_loop'] as const;

/**
 * The statuses a standing obligation may carry. `replaced`/`outdated` are past
 * belief and `contradicted` is disputed — none of the three is "still open".
 * `uncertain` stays in: an unconfirmed promise is still a promise (the answer
 * path frames it softly), which is the same admission rule extraction uses.
 */
export const OPEN_LOOP_STATUSES = ['active', 'user_approved', 'uncertain'] as const;

/** Read cap, mirroring every other bounded engine read. */
const OPEN_LOOP_POOL = 200;

// ── Temporal read contracts ──────────────────────────────────

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
    /** Org resolution for audit stamping — optional so
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
   * The open loops: the caller's standing
   * commitments and open items, read straight from memory — no derived table
   * behind it. Kinds `commitment`/`open_loop`, gated exactly like every other
   * read, narrowed to the statuses that still STAND (`replaced`, `outdated`
   * and `contradicted` are closed or disputed, never "still open"), optionally
   * scoped to one entity, ordered by due date (`valid_until`) first so the
   * most pressing surface at the top.
   *
   * This is the durable core of the day-one question"what did I decide,
   * promise, and commit to, and what is still open?" — and it needs no schema
   * of its own: the extractor already labels the kind and the temporal pass
   * already fills `valid_until`.
   *
   * FIRST-PERSON RULE. An obligation is only the caller's when the caller wrote
   * the words it came from (`authored_by_user`). A loan agreement says "the
   * Lender shall advance the principal sum"; that is a true fact ABOUT the
   * document and it is stored as one, but it is not something the user promised,
   * so it must never appear as their open loop. Extraction is unchanged: the
   * document's obligations are still remembered and still retrievable. Only this
   * read is narrowed, and it is narrowed HERE so the attention feed and the
   * "what is still open" answer cannot drift apart.
   */
  async openLoopsForPrincipal(
    principal: Principal,
    opts: ReadOptions & { entity?: string; limit?: number } = {},
  ): Promise<MemoryRow[]> {
    const rows = await this.db
      .select()
      .from(memory)
      .where(
        and(
          this.visibleTo(principal, opts),
          inArray(memory.kind, OPEN_LOOP_KINDS as unknown as FactKind[]),
          inArray(memory.status, OPEN_LOOP_STATUSES as unknown as MemoryStatus[]),
          eq(memory.authoredByUser, true),
        ),
      )
      .orderBy(sql`${memory.validUntil} ASC NULLS LAST`, desc(memory.updatedAt), memory.id)
      .limit(Math.min(opts.limit ?? OPEN_LOOP_POOL, OPEN_LOOP_POOL));
    const wanted = opts.entity?.trim().toLowerCase();
    if (!wanted) return rows;
    return rows.filter(
      (row) =>
        row.entities.some((e) => e.toLowerCase().includes(wanted)) ||
        (row.subjectEntity !== null && row.subjectEntity.toLowerCase().includes(wanted)),
    );
  }

  /**
   * A subject's memories for the time-travel view: rows this
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
   * status, for a full data export (spec §11.4, the Memory Passport). Paged internally
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
   * consumes (spec §11.4) — owner-scoped by the signed payload's `requested_by`, the
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
   * How many memories one source has yielded, gated (V2.0 item 3.7).
   *
   * The request paths that show a per-source fact count — the research run's
   * progress list — used to reach the ungated `listBySourceSystem` and take its
   * length, which was the one system read genuinely being called from a
   * controller. Same number, through the same gate as every other read: a
   * source's derived memories all carry the source's owner, so for the owner
   * asking about their own source this counts exactly the same rows.
   */
  async countBySourceForPrincipal(
    principal: Principal,
    sourceType: SourceType,
    sourceId: string,
  ): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memory)
      .where(
        and(
          this.visibleTo(principal, { includeSensitive: true }),
          eq(memory.sourceType, sourceType),
          eq(memory.sourceId, sourceId),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /**
   * The distinct sources the caller's visible memories point at, newest first
   * by earliest fact (V2.2 item 5.2). This is how source KINDS with no table
   * row of their own enumerate for the catalog: a chat capture's only durable
   * trace is its facts' provenance, and a discard-mode file's metadata row
   * never existed. One grouped query over `memory_source_idx`; the cursor is
   * the group's min(created_at), so pages are stable under new ingestion.
   */
  async listSourceRefsForPrincipal(
    principal: Principal,
    options: {
      sourceType?: SourceType;
      cursor?: Date;
      order?: 'asc' | 'desc';
      limit?: number;
    } = {},
  ): Promise<{ sourceType: SourceType; sourceId: string; firstAt: Date; facts: number }[]> {
    const limit = Math.min(options.limit ?? 50, 200);
    const clauses: SQL[] = [this.visibleTo(principal, { includeSensitive: true })];
    if (options.sourceType) clauses.push(eq(memory.sourceType, options.sourceType));
    const grouped = this.db
      .select({
        sourceType: memory.sourceType,
        sourceId: memory.sourceId,
        firstAt: sql<string>`min(${memory.createdAt})`.as('first_at'),
        facts: sql<number>`count(*)::int`.as('facts'),
      })
      .from(memory)
      .where(and(...clauses))
      .groupBy(memory.sourceType, memory.sourceId)
      .as('grouped');
    const order = options.order ?? 'desc';
    const rows = await this.db
      .select()
      .from(grouped)
      .where(
        options.cursor
          ? order === 'desc'
            ? sql`${grouped.firstAt} < ${options.cursor}`
            : sql`${grouped.firstAt} > ${options.cursor}`
          : undefined,
      )
      .orderBy(order === 'desc' ? sql`${grouped.firstAt} DESC` : sql`${grouped.firstAt} ASC`)
      .limit(limit);
    return rows.map((row) => ({
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      firstAt: new Date(row.firstAt),
      facts: row.facts,
    }));
  }

  /**
   * Per-source fact statistics for ONE page of catalog rows (V2.2 item 5.2):
   * total visible facts and how many are superseded or uncertain, grouped, in
   * one indexed query over the page's refs — never a query per row.
   */
  async sourceFactStatsForRefs(
    principal: Principal,
    refs: readonly { sourceType: string; sourceId: string }[],
  ): Promise<Map<string, { facts: number; superseded: number; uncertain: number }>> {
    const out = new Map<string, { facts: number; superseded: number; uncertain: number }>();
    if (refs.length === 0) return out;
    const pairs = refs.map((ref) => sql`(${ref.sourceType}, ${ref.sourceId})`);
    const rows = await this.db
      .select({
        sourceType: memory.sourceType,
        sourceId: memory.sourceId,
        facts: sql<number>`count(*)::int`,
        superseded: sql<number>`count(*) FILTER (WHERE ${memory.status} = 'replaced')::int`,
        uncertain: sql<number>`count(*) FILTER (WHERE ${memory.status} = 'uncertain')::int`,
      })
      .from(memory)
      .where(
        and(
          this.visibleTo(principal, { includeSensitive: true }),
          sql`(${memory.sourceType}, ${memory.sourceId}) IN (${sql.join(pairs, sql`, `)})`,
        ),
      )
      .groupBy(memory.sourceType, memory.sourceId);
    for (const row of rows) {
      out.set(`${row.sourceType} ${row.sourceId}`, {
        facts: row.facts,
        superseded: row.superseded,
        uncertain: row.uncertain,
      });
    }
    return out;
  }

  /**
   * The refs of sources holding at least one visible memory in `status`
   * (V2.2 item 5.2): the driving query behind "every source with a superseded
   * fact" — the badge condition produces the rows, never a scan of all
   * sources testing each.
   */
  async sourceRefsWithStatus(
    principal: Principal,
    status: MemoryStatus,
    options: { limit?: number } = {},
  ): Promise<{ sourceType: SourceType; sourceId: string; firstAt: Date; facts: number }[]> {
    const grouped = this.db
      .select({
        sourceType: memory.sourceType,
        sourceId: memory.sourceId,
        firstAt: sql<string>`min(${memory.createdAt})`.as('first_at'),
        facts: sql<number>`count(*)::int`.as('facts'),
      })
      .from(memory)
      .where(this.visibleTo(principal, { includeSensitive: true }))
      .groupBy(memory.sourceType, memory.sourceId)
      .having(sql`count(*) FILTER (WHERE ${memory.status} = ${status}) > 0`)
      .as('grouped');
    const rows = await this.db
      .select()
      .from(grouped)
      .orderBy(sql`${grouped.firstAt} DESC`)
      .limit(Math.min(options.limit ?? 200, 500));
    return rows.map((row) => ({
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      firstAt: new Date(row.firstAt),
      facts: row.facts,
    }));
  }

  /**
   * Gated memory counts by lifecycle status — the dashboard's "memory by
   * status" visual. ONE grouped query under the same
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
   * The supersession chain through a memory, oldest → newest (spec §6,
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
   * Admission path for the ingestion pipeline (spec §2): the verification pass
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
   * with the not-yet-committed incoming facts.
   *
   * `reason` is advisory context for the CALLER only and is deliberately NOT
   * persisted: it can be model free-text naming private
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
     * When false, the Qdrant payload sync is DEFERRED to the caller
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
    // Keep the Qdrant payload copy honest (spec §4.2), point op last: a failure
    // rolls the row back and the caller retries — the two stores converge.
    // requireVectors, exactly like the toggles: a store wired without
    // Qdrant must throw here, never silently leave the point saying 'active'.
    if (opts.syncPayload !== false) {
      await this.requireVectors().setPayload(memoryId, { status: to });
    }
    return updated as MemoryRow;
  }

  /**
   * Batch the Qdrant `status` payload sync for already-committed transitions
   * — the deferred half of a `transitionInTx({ syncPayload: false })`
   * bulk change. Runs AFTER the caller's transaction commits, so no row lock is
   * held while these HTTP calls fan out. Idempotent (setPayload no-ops on a
   * not-yet-embedded point); the nightly payload-consistency sweep  reconciles anything a transient Qdrant failure here leaves stale.
   *
   * Deliberately NOT part of the worker-only system surface (V2.0 item 3.7):
   * it reads no memory content and returns none — it writes the status field
   * of points whose ids the caller changed under the owner gate
   * ({@link bulkMarkOutdatedForOwner}), which is why the approved bulk action
   * can call it from either process.
   */
  async syncStatusPayloads(memoryIds: string[], status: MemoryStatus): Promise<void> {
    const vectors = this.requireVectors();
    for (const id of memoryIds) {
      await vectors.setPayload(id, { status });
    }
  }

  /**
   * Bulk "mark outdated" for an owner's own memories — the effect behind the
   * approved bulk action (§3), run inside the approval executor's job
   * transaction. The Memory aggregate owns the eligibility rules (spec §15 rule 4)
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
   * Qdrant is NOT touched here: the transitions run PG-only and the
   * caller batches the payload sync for `changed` AFTER the transaction commits
   * (via {@link syncStatusPayloads}), so this loop never holds up to 500 row
   * locks across 500 sequential Qdrant HTTP calls. The nightly payload sweep
   * is the backstop if that deferred sync misses one.
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
   * change in the same act as the row. Two-store pattern: row update +
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
   * Scope change — the private↔shared visibility switch, owner-only and
   * audited, in the SAME two-store pattern as the sensitive toggle: the row and
   * the Qdrant payload's `scope` field move together, so a shared→private demote
   * takes effect in vector search the instant it commits (a demoted leak is
   * still a leak — AGENTS.md spec §4.2). setPayload runs last: if it throws the row
   * write rolls back and the retry converges. Everything derived from a
   * memory follows the memory: there is no second visibility rule to keep in
   * step.
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
      // Authorship is provenance and survives supersession, exactly like
      // source_type and source_id. Dropping it here would silently take an
      // edited commitment out of the owner's open loops.
      authoredByUser: old.authoredByUser ?? undefined,
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
            'source-level deletion goes through the deletion saga (spec §11.1)',
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
   * Supersession (spec §6): the ONLY path to `replaced`. Creates the successor,
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
   *.
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
    // Payload copy honesty (spec §4.2): the predecessor's point now says replaced.
    // requireVectors like the toggles — never a silent skip.
    await this.requireVectors().setPayload(old.id, { status: 'replaced' });
    return { predecessor: predecessor as MemoryRow, successor };
  }

  // ── Search primitives (0003 ruling 2: Principal-gated, gates in the store) ──

  /**
   * Semantic search over the Qdrant index. The scope and sensitive gates are
   * native payload pre-filters INSIDE the vector query (spec §4.2/spec §3.4) — an
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
   * 0005;: simple config + unaccent). The scope and
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
   * Trigram entity match: query names against the
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
   * Subject-entity match (V2.3 item 6.1): rows anchored to any of the given
   * names, by case-insensitive equality or trigram proximity on
   * `subject_entity`, gated exactly like every other read. SQL recall only —
   * the caller applies the canonical alias-aware match for precision. This is
   * the one search that can surface a cross-language counterpart, whose
   * embedding similarity and full-name trigram distance are both unhelpful.
   */
  async subjectSearch(
    principal: Principal,
    names: string[],
    opts: FilteredSearchOptions,
  ): Promise<MemoryRow[]> {
    const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
    if (wanted.length === 0) return [];
    const namesArray = sql`ARRAY[${sql.join(
      wanted.map((name) => sql`${name}`),
      sql`, `,
    )}]::text[]`;
    const rows = await this.db
      .select()
      .from(memory)
      .where(
        and(
          this.visibleTo(principal, opts),
          sql`subject_entity IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(${namesArray}) AS wanted(name)
            WHERE lower(subject_entity) = lower(wanted.name)
               OR subject_entity % wanted.name
          )`,
          ...this.filterClauses(principal, opts),
        ),
      )
      .orderBy(memory.id)
      .limit(opts.topK);
    return rows;
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

  // ── Temporal primitives (spec §3.4 temporal lift, spec §6) ──────────

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
   * event set of — learned / status_changed /
   * superseded — newest first. Erased memories resolve to no row and produce
   * no event (their ledger is the Forgotten section, spec §11.1).
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

    const auditRows = await readAuditEntries(this.db, {
      actions: [...CHANGE_STATUS_ACTIONS, ...CHANGE_SUPERSEDE_ACTIONS],
      entityType: 'memory',
      since,
      // restrict to the caller's OWN memory events BEFORE the limit.
      // Without this the query scans all owners' events and, on a busy
      // instance, another owner's changes push the caller's out of the
      // window — silently missing from "what changed since". Memory
      // status/supersede audit rows are always stamped with the memory
      // owner's id (never null), so ownership = visibility here (v1 notes
      // are private; the getManyForPrincipal re-check below still enforces
      // the scope + sensitive gates as defence in depth).
      ownerId: principal.userId,
      limit: limit * 2,
    });
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
      const detail = row.detail ?? {};
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

  private requireVectors(): MemoryVectorStore {
    if (!this.vectors) {
      throw new NotImplementedException(
        'MemoryStore was constructed without a vector store (Qdrant), register MemoryModule with a qdrantUrl',
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
    if (filters.sourceType && filters.sourceId) {
      clauses.push(eq(memory.sourceType, filters.sourceType));
      clauses.push(eq(memory.sourceId, filters.sourceId));
    }
    if (filters.uncertaintyReason) {
      clauses.push(eq(memory.uncertaintyReason, filters.uncertaintyReason));
    }
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
  /** The gate itself lives in `domain/scope-gate.ts` (V2.0 item 3.7): one
   * definition, two tables. This names the columns and nothing else. */
  private visibleTo(principal: Principal, opts: ReadOptions): SQL {
    return visibleToPrincipal(
      { ownerId: memory.ownerId, scope: memory.scope, sensitive: memory.sensitive },
      principal,
      opts,
    );
  }

  private async insertFact(
    tx: Tx,
    ownerId: string,
    fact: NewFact,
    actor: string,
  ): Promise<MemoryRow> {
    // Provenance is NOT NULL, always: the aggregate rejects orphans even
    // where the database could not (an empty string satisfies a NOT NULL column).
    if (!ownerId.trim() || !fact.sourceType || !fact.sourceId.trim()) {
      throw new BadRequestException(
        'a memory requires owner_id, source_type and source_id: no orphans, ever',
      );
    }
    // The admission taxonomy is total (V2.0 item 3.3): an uncertain fact always
    // knows why, and nothing else carries a reason. Enforced here, in the
    // aggregate that owns every write path, rather than by a CHECK constraint
    // that later status transitions would have to keep re-satisfying.
    // The registry boundary (spec §15.3): the column is text since migration
    // 0040, so the write funnel enforces what the database enum used to — a
    // provenance value must be registered. Compile-time the union already
    // guarantees it; this guards the JS callers (eval, seeds) the types
    // cannot see. Defunct values pass validation (a defunct value is a KNOWN
    // value) but have no live producer.
    if (!isRegisteredSourceType(fact.sourceType)) {
      throw new BadRequestException(`unknown source type '${String(fact.sourceType)}'`);
    }
    const status = fact.initialStatus ?? 'active';
    if (status === 'uncertain' && !fact.uncertaintyReason) {
      throw new BadRequestException(
        'an uncertain memory requires its uncertainty reason: the admission taxonomy has no default arm',
      );
    }
    if (status !== 'uncertain' && fact.uncertaintyReason) {
      throw new BadRequestException(
        `uncertaintyReason is only meaningful on an uncertain admission (got status '${status}')`,
      );
    }
    const [row] = await tx
      .insert(memory)
      .values({
        ownerId,
        scope: fact.scope,
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
        status,
        uncertaintyReason: fact.uncertaintyReason,
        sensitive: fact.sensitive ?? false,
        entities: fact.entities ?? [],
        subjectEntity: fact.subjectEntity,
        kind: fact.kind,
        authoredByUser: fact.authoredByUser,
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
      detail: {
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
        scope: fact.scope,
        // An enum value, never content: which arm of the admission taxonomy
        // this fact landed on, so the automatic decision is accountable.
        ...(fact.uncertaintyReason ? { uncertaintyReason: fact.uncertaintyReason } : {}),
      },
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
