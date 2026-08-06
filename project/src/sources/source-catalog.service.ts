import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  Principal,
  SourceBadgeFilter,
  SourceBadgesDto,
  SourceCatalogItemDto,
  SourceCatalogPageDto,
  SourceInspectionDto,
} from '@cogeto/shared';
import { isRegisteredSourceType, sourceTypeDescriptor } from '@cogeto/shared';
import { DRIZZLE, jobRunStates } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import {
  MemoryObjectStore,
  MemoryReconciliation,
  MemoryStore,
  listFileSourceRefs,
  toListItem,
} from '../memory/index';
import type { SourceType } from '../memory/index';
import {
  INGESTION_PIPELINE_JOB_TYPE,
  SuppressedFactLog,
  SourceContextStore,
  SourceRevisionStore,
  contextNamesForSources,
  latestGateRefusalFor,
  refusalsForSources,
  sourceRefsWithRefusals,
  sourceRefsWithSuppressed,
  suppressedCountsForSources,
  verificationsForMemories,
} from '../ingestion/index';
import { keysWithReadOutcome, readOutcomesForKeys } from '../files/index';
import { listNoteSources, hydrateNoteSources } from '../notes/index';
import { listEmailSources, hydrateEmailSources } from '../email/index';
import { listWebSources, hydrateWebSources } from '../research/index';
import { hydrateChatSources } from '../chat/index';

/** Read outcomes that mean the source produced no text (the honesty rule). */
const UNREAD_OUTCOMES = ['empty', 'unsupported_format', 'read_failed', 'needs_vision'] as const;

/** One assembled-but-unbadged row. */
interface CatalogRef {
  sourceType: SourceType;
  sourceId: string;
  name: string | null;
  at: Date;
}

export interface CatalogQuery {
  type?: SourceType;
  badge?: SourceBadgeFilter;
  q?: string;
  order?: 'asc' | 'desc';
  cursor?: Date;
  limit?: number;
}

/** How many refs a badge-driven or searched list is bounded to, stated in the
 * response by the absent cursor: these lists are served whole. */
const BADGE_SCAN_LIMIT = 500;

/**
 * The source catalog (V2.2 item 5.2, issue A): one row per source, whatever
 * its type, with the badges that make the list the product's scan layer.
 *
 * This module is a declared composition context (the `attention`/`operations`
 * precedent): it owns no tables and reads every module through its public
 * interface — the family listing functions, memory's gated stores, and the
 * grouped badge reads — so "one row per source" never becomes a cross-module
 * table query.
 *
 * Cost discipline (issue A3): enumeration is cursor-paged per type and
 * k-way-merged by date; badges are computed for THE PAGE with one grouped
 * query per fact family (facts/superseded, contradictions, suppressed,
 * refusals, read outcomes, job states) — never a query per row. Badge-driven
 * filters run their own indexed driving query and hydrate only the hits.
 */
@Injectable()
export class SourceCatalogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly memory: MemoryStore,
    private readonly reconciliation: MemoryReconciliation,
    private readonly objects: MemoryObjectStore,
    private readonly suppressed: SuppressedFactLog,
    private readonly contexts: SourceContextStore,
    private readonly revisions: SourceRevisionStore,
  ) {}

  async list(principal: Principal, query: CatalogQuery): Promise<SourceCatalogPageDto> {
    const limit = Math.min(query.limit ?? 50, 100);
    if (query.badge) {
      const refs = await this.refsForBadge(principal, query.badge);
      const hydrated = await this.hydrate(principal, refs);
      hydrated.sort((a, b) =>
        (query.order ?? 'desc') === 'desc'
          ? b.at.getTime() - a.at.getTime()
          : a.at.getTime() - b.at.getTime(),
      );
      const items = await this.badge(principal, hydrated.slice(0, BADGE_SCAN_LIMIT));
      // A badge list is served whole (bounded): the point of the filter is the
      // complete set of flagged sources, not an endless scroll.
      return { items, nextCursor: null };
    }

    if (query.q?.trim()) {
      const refs = await this.refsForSearch(principal, query.q.trim(), query.type);
      const hydrated = await this.hydrate(principal, refs);
      hydrated.sort((a, b) => b.at.getTime() - a.at.getTime());
      return { items: await this.badge(principal, hydrated.slice(0, limit)), nextCursor: null };
    }

    const refs = await this.enumerate(principal, query, limit);
    const page = refs.slice(0, limit);
    const items = await this.badge(principal, page);
    const nextCursor =
      refs.length > limit && page.length > 0 ? page[page.length - 1]!.at.toISOString() : null;
    return { items, nextCursor };
  }

  /** Level two: one source, fully explained, in one round trip. */
  async inspect(
    principal: Principal,
    sourceType: string,
    sourceId: string,
  ): Promise<SourceInspectionDto> {
    if (!isRegisteredSourceType(sourceType)) {
      throw new NotFoundException(`unknown source type '${sourceType}'`);
    }
    // The audit surface is the OWNER's: a peer reads shared facts in search
    // and chat, never a source's full inspection (the drawer's existing rule).
    // Ownership resolves structurally per type (the family row, the object-key
    // prefix, or the derived facts' provenance); a foreign or absent source is
    // the same NotFound, so existence never leaks.
    if (!(await this.ownsSource(principal, sourceType as SourceType, sourceId))) {
      throw new NotFoundException(`source ${sourceType}/${sourceId} not found`);
    }
    const facts = await this.memory.listForPrincipal(principal, {
      includeSensitive: true,
      sourceType: sourceType as SourceType,
      sourceId,
      mine: true,
      limit: 200,
    });
    const [verifications, suppressedPage, contradictions, context, refusal, revisionRows] =
      await Promise.all([
        verificationsForMemories(
          this.db,
          facts.map((row) => row.id),
        ),
        this.suppressed.list(principal, { sourceType, sourceId, limit: 200 }),
        this.reconciliation.contradictionsForSource(principal, sourceType, sourceId, {
          includeResolved: true,
        }),
        this.contexts.getForOwner(principal, sourceType, sourceId).catch(() => null),
        latestGateRefusalFor(this.db, { sourceType, sourceId }),
        this.revisions.forSource(principal, { sourceType, sourceId }),
      ]);
    return {
      sourceType,
      sourceId,
      facts: facts.map((row) => ({
        memory: toListItem(row),
        verification: verifications.get(row.id) ?? null,
      })),
      suppressed: suppressedPage.items.map((row) => ({
        id: row.id,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        factContent: row.factContent,
        factKind: row.factKind as SourceInspectionDto['suppressed'][number]['factKind'],
        sourceSpan: row.sourceSpan,
        spanLocators: row.spanLocators ?? null,
        reason: row.reason,
        verificationVerdict: row.verificationVerdict,
        verificationReason: row.verificationReason,
        promptVersion: row.promptVersion,
        memoryId: row.memoryId,
        createdAt: row.createdAt.toISOString(),
      })),
      contradictions: contradictions.map(({ relation, a, b }) => ({
        relationId: relation.id,
        detectedAt: relation.detectedAt.toISOString(),
        resolvedAt: relation.resolvedAt?.toISOString() ?? null,
        resolution: relation.resolution,
        reason: relation.reason,
        a: toListItem(a),
        b: toListItem(b),
      })),
      context: context
        ? {
            sourceType: context.sourceType,
            sourceId: context.sourceId,
            subjects: context.subjects,
            documentClass: context.documentClass,
            documentClassConfident: context.documentClassConfident,
            revision: context.revision,
            revisionConfident: context.revisionConfident,
            editedByUser: context.editedByUser,
            promptVersion: context.promptVersion,
            updatedAt: context.updatedAt.toISOString(),
          }
        : null,
      gateRefusal: refusal?.reason ?? null,
      revisions: revisionRows.map((row) => ({
        id: row.id,
        successorType: row.successorType,
        successorId: row.successorId,
        predecessorType: row.predecessorType,
        predecessorId: row.predecessorId,
        status: row.status,
        basis: row.basisJson ?? null,
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
      })),
    };
  }

  /** Structural per-type ownership: the family row, the key prefix plus any
   * stored trace, or the derived facts' provenance. */
  private async ownsSource(
    principal: Principal,
    sourceType: SourceType,
    sourceId: string,
  ): Promise<boolean> {
    if (sourceType === 'file') {
      const parts = sourceId.split('/');
      if (parts[0] !== principal.orgId || parts[1] !== principal.userId) return false;
      const described = await this.memory.describeSource('file', sourceId);
      if (described) return described.ownerId === principal.userId;
      const stat = await this.objects.statObject(sourceId).catch(() => null);
      if (stat) return true;
      const outcomes = await readOutcomesForKeys(this.db, [sourceId]);
      return outcomes.has(sourceId);
    }
    if (sourceType === 'user_note') {
      return (await hydrateNoteSources(this.db, principal.userId, [sourceId])).has(sourceId);
    }
    if (sourceType === 'email') {
      return (await hydrateEmailSources(this.db, principal.userId, [sourceId])).has(sourceId);
    }
    if (sourceType === 'web') {
      return (await hydrateWebSources(this.db, principal.userId, [sourceId])).has(sourceId);
    }
    if (sourceType === 'chat') {
      return (await hydrateChatSources(this.db, principal.userId, [sourceId])).has(sourceId);
    }
    // Container and defunct types have no inspection.
    return false;
  }

  // ── Enumeration ─────────────────────────────────────────────────────────

  private async enumerate(
    principal: Principal,
    query: CatalogQuery,
    limit: number,
  ): Promise<CatalogRef[]> {
    const options = { cursor: query.cursor, order: query.order ?? 'desc', limit: limit + 1 };
    const per: CatalogRef[][] = [];
    const wants = (type: SourceType) => !query.type || query.type === type;

    if (wants('user_note')) {
      const rows = await listNoteSources(this.db, principal.userId, options);
      per.push(rows.map((row) => ref('user_note', row.sourceId, row.name, row.at)));
    }
    if (wants('email')) {
      const rows = await listEmailSources(this.db, principal.userId, options);
      per.push(rows.map((row) => ref('email', row.sourceId, row.name, row.at)));
    }
    if (wants('web')) {
      const rows = await listWebSources(this.db, principal.userId, options);
      per.push(rows.map((row) => ref('web', row.sourceId, row.name, row.at)));
    }
    if (wants('chat')) {
      const refs = await this.memory.listSourceRefsForPrincipal(principal, {
        ...options,
        sourceType: 'chat',
      });
      const names = await hydrateChatSources(
        this.db,
        principal.userId,
        refs.map((r) => r.sourceId),
      );
      per.push(
        refs.map((r) => ref('chat', r.sourceId, names.get(r.sourceId)?.name ?? null, r.firstAt)),
      );
    }
    if (wants('file')) {
      per.push(await this.enumerateFiles(principal, options));
    }

    const order = query.order ?? 'desc';
    const merged = per
      .flat()
      .sort((a, b) =>
        order === 'desc' ? b.at.getTime() - a.at.getTime() : a.at.getTime() - b.at.getTime(),
      );
    return merged;
  }

  /** Stored uploads from file_metadata, plus discard-mode sources whose only
   * trace is their facts' provenance. Names resolve per page below. */
  private async enumerateFiles(
    principal: Principal,
    options: { cursor?: Date; order?: 'asc' | 'desc'; limit: number },
  ): Promise<CatalogRef[]> {
    const [stored, derived] = await Promise.all([
      listFileSourceRefs(this.db, principal.userId, options),
      this.memory.listSourceRefsForPrincipal(principal, { ...options, sourceType: 'file' }),
    ]);
    const byKey = new Map<string, CatalogRef>();
    for (const row of derived)
      byKey.set(row.sourceId, ref('file', row.sourceId, null, row.firstAt));
    // Metadata rows win the date (the upload moment) and add zero-fact files.
    for (const row of stored) byKey.set(row.objectKey, ref('file', row.objectKey, null, row.at));
    return [...byKey.values()];
  }

  private async refsForBadge(
    principal: Principal,
    badge: SourceBadgeFilter,
  ): Promise<{ sourceType: string; sourceId: string }[]> {
    switch (badge) {
      case 'contradicted':
        return this.reconciliation.sourceRefsWithOpenContradictions(principal);
      case 'superseded':
        return this.memory.sourceRefsWithStatus(principal, 'replaced');
      case 'suppressed':
        return sourceRefsWithSuppressed(this.db, principal);
      case 'gated':
        return sourceRefsWithRefusals(this.db, principal.userId);
      case 'truncated': {
        const keys = await keysWithReadOutcome(this.db, principal.userId, ['truncated']);
        return keys.map((key) => ({ sourceType: 'file', sourceId: key }));
      }
      case 'unreadable': {
        const keys = await keysWithReadOutcome(this.db, principal.userId, [...UNREAD_OUTCOMES]);
        return keys.map((key) => ({ sourceType: 'file', sourceId: key }));
      }
      case 'processing': {
        // No ledger row means queued or in flight, so the honest driving set is
        // the newest slice of the corpus tested against the queue: bounded and
        // stated (a source older than the scan window that is somehow still
        // processing will surface on its own row, just not in this filter).
        const recent = await this.enumerate(principal, {}, BADGE_SCAN_LIMIT);
        const states = await jobRunStates(
          this.db,
          recent.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId })),
          INGESTION_PIPELINE_JOB_TYPE,
        );
        return recent.filter((r) => states.get(`${r.sourceType} ${r.sourceId}`) === 'processing');
      }
    }
  }

  private async refsForSearch(
    principal: Principal,
    q: string,
    type?: SourceType,
  ): Promise<{ sourceType: string; sourceId: string }[]> {
    const wants = (t: SourceType) => !type || type === t;
    const out = new Map<string, { sourceType: string; sourceId: string }>();
    // Content search: the facts' own full-text index, any source type.
    const hits = await this.memory.ftsSearch(principal, q, {
      topK: 100,
      includeSensitive: true,
    });
    for (const hit of hits) {
      const t = hit.memory.sourceType;
      if (isRegisteredSourceType(t) && wants(t)) {
        out.set(`${t} ${hit.memory.sourceId}`, { sourceType: t, sourceId: hit.memory.sourceId });
      }
    }
    // Name search per family. Files are the stated exception: a filename lives
    // on the object (erased with the bytes, by design), so file matches come
    // from content only.
    const nameOptions = { q, limit: 50 };
    if (wants('user_note')) {
      for (const row of await listNoteSources(this.db, principal.userId, nameOptions)) {
        out.set(`user_note ${row.sourceId}`, { sourceType: 'user_note', sourceId: row.sourceId });
      }
    }
    if (wants('email')) {
      for (const row of await listEmailSources(this.db, principal.userId, nameOptions)) {
        out.set(`email ${row.sourceId}`, { sourceType: 'email', sourceId: row.sourceId });
      }
    }
    if (wants('web')) {
      for (const row of await listWebSources(this.db, principal.userId, nameOptions)) {
        out.set(`web ${row.sourceId}`, { sourceType: 'web', sourceId: row.sourceId });
      }
    }
    return [...out.values()];
  }

  // ── Hydration and badges ─────────────────────────────────────────────────

  /** Names and dates for refs that arrived from a driving query. */
  private async hydrate(
    principal: Principal,
    refs: readonly { sourceType: string; sourceId: string }[],
  ): Promise<CatalogRef[]> {
    const byType = new Map<string, string[]>();
    for (const r of refs) {
      const list = byType.get(r.sourceType) ?? [];
      list.push(r.sourceId);
      byType.set(r.sourceType, list);
    }
    const out: CatalogRef[] = [];
    const now = new Date();
    for (const [type, ids] of byType) {
      if (!isRegisteredSourceType(type)) continue;
      if (type === 'user_note') {
        const rows = await hydrateNoteSources(this.db, principal.userId, ids);
        for (const id of ids) {
          const row = rows.get(id);
          if (row) out.push(ref('user_note', id, row.name, row.at));
        }
      } else if (type === 'email') {
        const rows = await hydrateEmailSources(this.db, principal.userId, ids);
        for (const id of ids) {
          const row = rows.get(id);
          if (row) out.push(ref('email', id, row.name, row.at));
        }
      } else if (type === 'web') {
        const rows = await hydrateWebSources(this.db, principal.userId, ids);
        for (const id of ids) {
          const row = rows.get(id);
          if (row) out.push(ref('web', id, row.name, row.at));
        }
      } else if (type === 'chat') {
        const rows = await hydrateChatSources(this.db, principal.userId, ids);
        for (const id of ids) {
          const row = rows.get(id);
          if (row) out.push(ref('chat', id, row.name, row.at));
        }
      } else if (type === 'file') {
        // Ownership is the object-key prefix, minted at upload.
        for (const id of ids) {
          if (id.split('/')[1] === principal.userId) out.push(ref('file', id, null, now));
        }
        // The true date comes from the fact stats below when known; a plain
        // metadata date would need another query per hydrated badge list, and
        // the badge lists sort by flagged-ness first anyway.
      }
    }
    return out;
  }

  /** The page's badges, in one grouped query per family. */
  private async badge(
    principal: Principal,
    refs: readonly CatalogRef[],
  ): Promise<SourceCatalogItemDto[]> {
    if (refs.length === 0) return [];
    const keys = refs.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId }));
    const fileKeys = refs.filter((r) => r.sourceType === 'file').map((r) => r.sourceId);
    const [facts, contradictions, suppressedCounts, refusals, outcomes, jobStates, contextNames] =
      await Promise.all([
        this.memory.sourceFactStatsForRefs(principal, keys),
        this.reconciliation.openContradictionCountsForSources(principal, keys),
        suppressedCountsForSources(this.db, principal, keys),
        refusalsForSources(this.db, keys),
        readOutcomesForKeys(this.db, fileKeys),
        jobRunStates(this.db, keys, INGESTION_PIPELINE_JOB_TYPE),
        contextNamesForSources(this.db, principal.userId, keys),
      ]);
    const names = await this.fileNames(refs, contextNames);

    return refs.map((r) => {
      const key = `${r.sourceType} ${r.sourceId}`;
      const stat = facts.get(key);
      const outcome = r.sourceType === 'file' ? outcomes.get(r.sourceId) : undefined;
      const state = jobStates.get(key) ?? 'processing';
      const badges: SourceBadgesDto = {
        contradictions: contradictions.get(key) ?? 0,
        superseded: stat?.superseded ?? 0,
        suppressed: suppressedCounts.get(key) ?? 0,
        truncated: outcome?.outcome === 'truncated',
        gated: refusals.has(key),
        unreadable:
          (outcome !== undefined &&
            (UNREAD_OUTCOMES as readonly string[]).includes(outcome.outcome)) ||
          state === 'failed',
        processing: state === 'processing',
      };
      return {
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        name: r.name ?? names.get(r.sourceId) ?? null,
        at: r.at.toISOString(),
        factCount: stat?.facts ?? 0,
        badges,
      };
    });
  }

  /**
   * Display names for the page's file rows: the object's stored filename
   * (HEAD, page-scoped and parallel — a filename deliberately lives on the
   * bytes so it dies with them), falling back to the anchored first subject
   * for discarded originals.
   */
  private async fileNames(
    refs: readonly CatalogRef[],
    contextNames: Map<string, string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const fileRefs = refs.filter((r) => r.sourceType === 'file' && r.name === null);
    await Promise.all(
      fileRefs.map(async (r) => {
        const stat = await this.objects.statObject(r.sourceId).catch(() => null);
        const raw = stat?.metadata['original-filename'];
        if (raw) {
          try {
            out.set(r.sourceId, decodeURIComponent(raw));
            return;
          } catch {
            out.set(r.sourceId, raw);
            return;
          }
        }
        const anchored = contextNames.get(`file ${r.sourceId}`);
        if (anchored) out.set(r.sourceId, anchored);
      }),
    );
    return out;
  }
}

function ref(sourceType: SourceType, sourceId: string, name: string | null, at: Date): CatalogRef {
  return { sourceType, sourceId, name, at };
}

/** The catalog's registered-but-unlisted types, spelled for the conformance
 * test: container and defunct types never make rows. */
export const UNLISTED_SOURCE_TYPES = Object.freeze(
  (['chat_conversation', 'task_conclusion', 'calendar_event'] as const).filter((type) => {
    const descriptor = sourceTypeDescriptor(type);
    return descriptor !== undefined;
  }),
);
