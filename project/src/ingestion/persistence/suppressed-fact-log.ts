import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, lte, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { UNCERTAINTY_REASONS } from '@cogeto/shared';
import type { MemoryScope, Principal, UncertaintyReason } from '@cogeto/shared';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db, DbOrTx, Tx } from '../../infrastructure/index';
import { suppressedFactLog } from './tables';
import type { SuppressedFactRow } from './tables';
import { visibleToPrincipal } from '../../memory/index';

/**
 * The suppressed-fact log (V2.0 item 3.3): the record of every automatic
 * decision that demoted or withheld an extracted fact.
 *
 * The point of the log is that automatic resolution does not mean invisible
 * resolution. A fact admitted `uncertain` is inspectable in Sources AND
 * explained here; a fact not admitted at all exists only here, which is why the
 * entry carries the claim, its exact span and the verification detail rather
 * than an identifier and a code.
 *
 * Gating is memory's gating, not a weaker cousin: `owner_id`, `scope` and
 * `sensitive` are inherited from the source at write time and every read applies
 * the same scope + sensitive predicate `MemoryStore.visibleTo` applies. An entry
 * is exactly as visible as the fact it explains.
 */

/** One decision to record. Written inside the ingestion job's transaction. */
export interface SuppressedFactEntry {
  ownerId: string;
  scope: MemoryScope;
  sensitive: boolean;
  sourceType: string;
  sourceId: string;
  factContent: string;
  factKind: string | null;
  sourceSpan: string;
  reason: UncertaintyReason;
  /** NULL when no verification ran (a structurally invalid fact never does). */
  verificationVerdict: 'supported' | 'partial' | 'unsupported' | null;
  verificationReason: string | null;
  promptVersion: string | null;
  /** Set when the fact WAS admitted as uncertain; null when it was not admitted. */
  memoryId: string | null;
}

export interface SuppressedFactQuery {
  sourceType?: string;
  sourceId?: string;
  reason?: UncertaintyReason;
  /** Inclusive lower / upper bounds on `created_at`. */
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface SuppressedFactPage {
  items: SuppressedFactRow[];
  total: number;
}

/** Per-reason counts plus the total, for the source detail and the report. */
export interface SuppressedFactSummary {
  total: number;
  /** Every reason in the vocabulary, zeros included: a stable shape to render. */
  byReason: Record<UncertaintyReason, number>;
}

/** Read cap, mirroring every other bounded engine read. */
const MAX_PAGE = 200;

@Injectable()
export class SuppressedFactLog {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Records decisions inside the caller's transaction, so a suppression is
   * durable exactly when the ingestion run that made it is. Never its own
   * transaction: a log entry for a rolled-back run would describe a decision
   * nobody made.
   */
  async record(tx: Tx, entries: SuppressedFactEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await tx.insert(suppressedFactLog).values(entries);
  }

  /** Entries the principal may see, newest first. */
  async list(principal: Principal, query: SuppressedFactQuery = {}): Promise<SuppressedFactPage> {
    const where = and(this.visibleTo(principal), ...this.filters(query))!;
    const limit = Math.min(query.limit ?? 50, MAX_PAGE);
    const [items, totals] = await Promise.all([
      this.db
        .select()
        .from(suppressedFactLog)
        .where(where)
        .orderBy(desc(suppressedFactLog.createdAt))
        .limit(limit)
        .offset(query.offset ?? 0),
      this.db.select({ value: count() }).from(suppressedFactLog).where(where),
    ]);
    return { items, total: Number(totals[0]?.value ?? 0) };
  }

  /** Counts per reason under the same gate and the same filters. */
  async summarize(
    principal: Principal,
    query: SuppressedFactQuery = {},
  ): Promise<SuppressedFactSummary> {
    const where = and(this.visibleTo(principal), ...this.filters(query))!;
    const rows = await this.db
      .select({ reason: suppressedFactLog.reason, value: count() })
      .from(suppressedFactLog)
      .where(where)
      .groupBy(suppressedFactLog.reason);

    const byReason = Object.fromEntries(UNCERTAINTY_REASONS.map((r) => [r, 0])) as Record<
      UncertaintyReason,
      number
    >;
    let total = 0;
    for (const row of rows) {
      const value = Number(row.value);
      byReason[row.reason] = value;
      total += value;
    }
    return { total, byReason };
  }

  /**
   * Deletion-saga leg (through ingestion's `DerivedCascade`): removes every
   * entry derived from these sources and returns the count for the receipt.
   * Runs inside the saga's enumeration transaction.
   */
  async deleteForSources(
    tx: Tx,
    refs: readonly { sourceType: string; sourceId: string }[],
  ): Promise<number> {
    if (refs.length === 0) return 0;
    const clauses = refs.map((ref) =>
      and(
        eq(suppressedFactLog.sourceType, ref.sourceType),
        eq(suppressedFactLog.sourceId, ref.sourceId),
      )!,
    );
    const removed = await tx
      .delete(suppressedFactLog)
      .where(or(...clauses)!)
      .returning({ id: suppressedFactLog.id });
    return removed.length;
  }

  /**
   * The admitted half, keyed by memory rather than by source: an entry whose
   * memory is being erased goes with it even when the erasure did not come
   * through that memory's own source (a merged supersession chain that crossed
   * sources). The by-source leg above is the complete enumeration; this one
   * closes the cross-source gap the saga's own header documents.
   */
  async deleteForMemories(tx: Tx, memoryIds: readonly string[]): Promise<number> {
    if (memoryIds.length === 0) return 0;
    const removed = await tx
      .delete(suppressedFactLog)
      .where(inArray(suppressedFactLog.memoryId, [...memoryIds]))
      .returning({ id: suppressedFactLog.id });
    return removed.length;
  }

  /** Test/verification seam: the raw rows for a source, ungated. Worker-side. */
  async forSource(db: DbOrTx, sourceType: string, sourceId: string): Promise<SuppressedFactRow[]> {
    return db
      .select()
      .from(suppressedFactLog)
      .where(
        and(
          eq(suppressedFactLog.sourceType, sourceType),
          eq(suppressedFactLog.sourceId, sourceId),
        )!,
      )
      .orderBy(suppressedFactLog.createdAt);
  }

  /**
   * The scope + sensitive gate, character for character the memory rule: own
   * rows or shared ones, and a sensitive row only for its owner. Sensitive
   * entries are NOT returned to peers under any option, because unlike memory
   * reads there is no per-query opt-in worth having here: the log is an audit
   * surface over your own corpus.
   */
  private visibleTo(principal: Principal): SQL {
    return visibleToPrincipal(
      {
        ownerId: suppressedFactLog.ownerId,
        scope: suppressedFactLog.scope,
        sensitive: suppressedFactLog.sensitive,
      },
      principal,
      // The owner's own sensitive entries are included; a PEER's never are,
      // which is what the shared gate's opt-in already means.
      { includeSensitive: true },
    );
  }

  /** Filters are ANDed onto the gate, never a substitute for it. */
  private filters(query: SuppressedFactQuery): SQL[] {
    const clauses: SQL[] = [];
    if (query.sourceType) clauses.push(eq(suppressedFactLog.sourceType, query.sourceType));
    if (query.sourceId) clauses.push(eq(suppressedFactLog.sourceId, query.sourceId));
    if (query.reason) clauses.push(eq(suppressedFactLog.reason, query.reason));
    if (query.from) clauses.push(gte(suppressedFactLog.createdAt, query.from));
    if (query.to) clauses.push(lte(suppressedFactLog.createdAt, query.to));
    return clauses;
  }
}

/** Composition helper for non-Nest callers (integration tests, eval). */
export function createSuppressedFactLog(db: Db): SuppressedFactLog {
  return new SuppressedFactLog(db);
}
