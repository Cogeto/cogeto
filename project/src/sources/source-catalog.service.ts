import { Inject, Injectable, Optional } from '@nestjs/common';
import type {
  Principal,
  SourceBadgeFilter,
  SourceBadgesDto,
  SourceCatalogItemDto,
  SourceCatalogPageDto,
  SourceInspectionDto,
  SourceOriginDto,
} from '@cogeto/shared';
import {
  DEFAULT_SPACE_ID,
  isRegisteredSourceType,
  resolveSpaceId,
  sourceTypeDescriptor,
} from '@cogeto/shared';
import { DRIZZLE, jobRunStates, userError } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import {
  MemoryObjectStore,
  MemoryReconciliation,
  MemoryStore,
  fileKeySpaces,
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
import { ConfluencePageStore } from '../confluence/index';
import { ConnectorItemLedger } from '../connectors/index';
import { listNoteSources, hydrateNoteSources } from '../notes/index';
import { listEmailSources, hydrateEmailSources } from '../email/index';
import { listWebSources, hydrateWebSources } from '../research/index';
import { hydrateChatSources } from '../chat/index';
import { ProjectService } from '../projects/index';

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
  /** Only this project's sources (V2.5 item 8.3 issue C3). A filter over
   * containers, never a permission: an unassigned or other-project source is
   * still the caller's own and still listed everywhere else. */
  projectId?: string;
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
    /** Connector provenance (V2.5 item 8.2), read through the owning
     * modules' public stores like every other family. Optional: a root
     * without connectors still serves the catalog, minus origins. */
    @Optional() private readonly confluencePages?: ConfluencePageStore,
    @Optional() private readonly connectorItems?: ConnectorItemLedger,
    /** Projects (V2.5 item 8.3): the project filter's driving query and each
     * row's project. Optional: without it the catalog is exactly what it
     * was, and every row's project reads null. */
    @Optional() private readonly projects?: ProjectService,
  ) {}

  async list(principal: Principal, query: CatalogQuery): Promise<SourceCatalogPageDto> {
    const limit = Math.min(query.limit ?? 50, 100);
    // The project filter drives the list from the project's own assignments
    // (V2.5 item 8.3): bounded and served whole, the badge-filter shape.
    if (query.projectId) {
      const assigned =
        (await this.projects?.sourceRefsFor(query.projectId, BADGE_SCAN_LIMIT)) ?? [];
      const refs = assigned
        .filter((ref) => isRegisteredSourceType(ref.sourceType))
        .filter((ref) => !query.type || ref.sourceType === query.type)
        .map((ref) => ({
          sourceType: ref.sourceType as SourceType,
          sourceId: ref.sourceId,
          name: null,
          at: new Date(0),
        }));
      const hydrated = await this.hydrate(principal, refs);
      hydrated.sort((a, b) =>
        (query.order ?? 'desc') === 'desc'
          ? b.at.getTime() - a.at.getTime()
          : a.at.getTime() - b.at.getTime(),
      );
      return {
        items: await this.badge(principal, hydrated.slice(0, BADGE_SCAN_LIMIT)),
        nextCursor: null,
      };
    }
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
      throw userError.notFound('source.unknownType', "unknown source type '{{type}}'", {
        type: sourceType,
      });
    }
    // The audit surface is the OWNER's: a peer reads shared facts in search
    // and chat, never a source's full inspection (the drawer's existing rule).
    // Ownership resolves structurally per type (the family row, the object-key
    // prefix, or the derived facts' provenance); a foreign or absent source is
    // the same NotFound, so existence never leaks.
    if (!(await this.ownsSource(principal, sourceType as SourceType, sourceId))) {
      throw userError.notFound('source.notFound', 'source {{sourceType}}/{{sourceId}} not found', {
        sourceType,
        sourceId,
      });
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
    // One events read for the page's findings (V2.3 item 6.1): the history
    // rides along with each contradiction, owner-gated inside the read.
    const relationEvents = await this.reconciliation.eventsForRelations(
      principal,
      contradictions.map(({ relation }) => relation.id),
    );
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
        detectedBy: relation.detectedBy ?? null,
        events: (relationEvents.get(relation.id) ?? []).map((event) => ({
          event: event.event,
          detail: (event.detailJson as Record<string, unknown> | null) ?? null,
          createdAt: event.createdAt.toISOString(),
        })),
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
      origin:
        (await this.originsFor(principal.userId, [{ sourceType, sourceId }])).get(
          `${sourceType} ${sourceId}`,
        ) ?? null,
      // Which project groups this source (V2.5 item 8.3 issue C3).
      projectId:
        (await this.projects?.projectIdsForRefs(principal.userId, sourceType, [sourceId]))?.get(
          sourceId,
        ) ?? null,
    };
  }

  /** Structural per-type ownership: the family row, the key prefix plus any
   * stored trace, or the derived facts' provenance. */
  private async ownsSource(
    principal: Principal,
    sourceType: SourceType,
    sourceId: string,
  ): Promise<boolean> {
    const spaceId = resolveSpaceId(principal);
    if (sourceType === 'file') {
      const parts = sourceId.split('/');
      if (parts[0] !== principal.orgId || parts[1] !== principal.userId) return false;
      const described = await this.memory.describeSource('file', sourceId);
      // The space seals inspection like every read: the owner's own source in
      // another space reads as absent, never as visible-from-here.
      if (described) return described.ownerId === principal.userId && described.spaceId === spaceId;
      const stored = await fileKeySpaces(this.db, principal.userId, [sourceId]);
      const storedSpace = stored.get(sourceId);
      if (storedSpace !== undefined) return storedSpace === spaceId;
      // No metadata row anywhere and no derived memories: the remaining
      // traces (a bare object, a read-outcome row) carry no space of their
      // own, and anything spaced was created after the migration with a row
      // or a memory, so these can only be default-space material.
      if (spaceId !== DEFAULT_SPACE_ID) return false;
      const stat = await this.objects.statObject(sourceId).catch(() => null);
      if (stat) return true;
      const outcomes = await readOutcomesForKeys(this.db, [sourceId]);
      return outcomes.has(sourceId);
    }
    if (sourceType === 'user_note') {
      return (await hydrateNoteSources(this.db, principal.userId, [sourceId], spaceId)).has(
        sourceId,
      );
    }
    if (sourceType === 'email') {
      return (await hydrateEmailSources(this.db, principal.userId, [sourceId], spaceId)).has(
        sourceId,
      );
    }
    if (sourceType === 'web') {
      return (await hydrateWebSources(this.db, principal.userId, [sourceId], spaceId)).has(
        sourceId,
      );
    }
    if (sourceType === 'chat') {
      return (await hydrateChatSources(this.db, principal.userId, [sourceId], spaceId)).has(
        sourceId,
      );
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
    const options = {
      cursor: query.cursor,
      order: query.order ?? 'desc',
      limit: limit + 1,
      // One space per catalog page (docs/features/spaces.md): every family
      // listing narrows to the caller's current space.
      spaceId: resolveSpaceId(principal),
    };
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
        resolveSpaceId(principal),
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
        return (await this.sealFileKeys(principal, keys)).map((key) => ({
          sourceType: 'file',
          sourceId: key,
        }));
      }
      case 'unreadable': {
        const keys = await keysWithReadOutcome(this.db, principal.userId, [...UNREAD_OUTCOMES]);
        return (await this.sealFileKeys(principal, keys)).map((key) => ({
          sourceType: 'file',
          sourceId: key,
        }));
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
    const nameOptions = { q, limit: 50, spaceId: resolveSpaceId(principal) };
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
    const spaceId = resolveSpaceId(principal);
    for (const [type, ids] of byType) {
      if (!isRegisteredSourceType(type)) continue;
      if (type === 'user_note') {
        const rows = await hydrateNoteSources(this.db, principal.userId, ids, spaceId);
        for (const id of ids) {
          const row = rows.get(id);
          if (row) out.push(ref('user_note', id, row.name, row.at));
        }
      } else if (type === 'email') {
        const rows = await hydrateEmailSources(this.db, principal.userId, ids, spaceId);
        for (const id of ids) {
          const row = rows.get(id);
          if (row) out.push(ref('email', id, row.name, row.at));
        }
      } else if (type === 'web') {
        const rows = await hydrateWebSources(this.db, principal.userId, ids, spaceId);
        for (const id of ids) {
          const row = rows.get(id);
          if (row) out.push(ref('web', id, row.name, row.at));
        }
      } else if (type === 'chat') {
        const rows = await hydrateChatSources(this.db, principal.userId, ids, spaceId);
        for (const id of ids) {
          const row = rows.get(id);
          if (row) out.push(ref('chat', id, row.name, row.at));
        }
      } else if (type === 'file') {
        // Ownership is the object-key prefix, minted at upload; the space is
        // the caller's current one, sealed exactly like the family hydrators.
        for (const id of await this.sealFileKeys(
          principal,
          ids.filter((id) => id.split('/')[1] === principal.userId),
        )) {
          out.push(ref('file', id, null, now));
        }
        // The true date comes from the fact stats below when known; a plain
        // metadata date would need another query per hydrated badge list, and
        // the badge lists sort by flagged-ness first anyway.
      }
    }
    return out;
  }

  /**
   * The file refs' space seal (docs/features/spaces.md): a stored key must
   * have its metadata row in the caller's space; a discard key (no row) is
   * resolved through the gated describeSource read, and a key with neither is
   * default-space material by construction (anything spaced was created after
   * the migration with a row or a memory).
   */
  private async sealFileKeys(principal: Principal, keys: readonly string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const spaceId = resolveSpaceId(principal);
    const stored = await fileKeySpaces(this.db, principal.userId, keys);
    const out: string[] = [];
    for (const key of keys) {
      const storedSpace = stored.get(key);
      if (storedSpace !== undefined) {
        if (storedSpace === spaceId) out.push(key);
        continue;
      }
      const described = await this.memory.describeSource('file', key);
      if (described) {
        if (described.ownerId === principal.userId && described.spaceId === spaceId) out.push(key);
        continue;
      }
      if (spaceId === DEFAULT_SPACE_ID) out.push(key);
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
    const origins = await this.originsFor(principal.userId, keys);
    // Each row's project (V2.5 item 8.3 issue C3), for the whole page in one
    // indexed read per source type rather than one per row.
    const projects = await this.projectsFor(principal.userId, keys);

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
        origin: origins.get(key) ?? null,
        projectId: projects.get(key) ?? null,
      };
    });
  }

  /** The page's project assignments, one keyed read per source type. */
  private async projectsFor(
    ownerId: string,
    keys: readonly { sourceType: string; sourceId: string }[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.projects || keys.length === 0) return out;
    const byType = new Map<string, string[]>();
    for (const key of keys) {
      (byType.get(key.sourceType) ?? byType.set(key.sourceType, []).get(key.sourceType)!).push(
        key.sourceId,
      );
    }
    for (const [sourceType, ids] of byType) {
      const found = await this.projects.projectIdsForRefs(ownerId, sourceType, ids);
      for (const [sourceId, projectId] of found) out.set(`${sourceType} ${sourceId}`, projectId);
    }
    return out;
  }

  /**
   * Connector provenance for the page's rows (V2.5 item 8.2): what space,
   * which page, which version, and whether the upstream still lists it. Read
   * through the owning modules' public stores, exactly like every family.
   */
  private async originsFor(
    ownerId: string,
    keys: readonly { sourceType: string; sourceId: string }[],
  ): Promise<Map<string, SourceOriginDto>> {
    const out = new Map<string, SourceOriginDto>();
    if (!this.confluencePages) return out;
    const fileKeys = keys.filter((k) => k.sourceType === 'file');
    if (fileKeys.length === 0) return out;
    const [pages, upstream] = await Promise.all([
      this.confluencePages.forOwnerSources(ownerId, fileKeys),
      this.connectorItems
        ? this.connectorItems.upstreamStateForSources(ownerId, fileKeys)
        : Promise.resolve(new Map<string, { state: string; reason: string | null }>()),
    ]);
    for (const [key, row] of pages) {
      const gone = upstream.get(key);
      out.set(key.replace(':', ' '), {
        connectorKind: 'confluence',
        kind: row.kind,
        title: row.title,
        spaceKey: row.spaceKey,
        spaceName: row.spaceName,
        version: row.version,
        url: row.url,
        parentTitle: row.parentTitle,
        upstreamGone: gone?.state === 'deleted_upstream' ? (gone.reason ?? 'absent') : null,
      });
    }
    return out;
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
