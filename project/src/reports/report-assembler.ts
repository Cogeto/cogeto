import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { FindingsReportCountsDto, Principal } from '@cogeto/shared';
import { FINDINGS_REPORT_VERSION, isRegisteredSourceType } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import {
  MemoryObjectStore,
  MemoryReconciliation,
  MemoryStore,
  listFileSourceRefs,
} from '../memory/index';
import type { MemoryRow, SourceType } from '../memory/index';
import {
  ACTIVE_PROMPTS,
  RECONCILE_CONFIG_VERSION,
  SuppressedFactLog,
  SourceContextStore,
  SourceRevisionStore,
  latestGateRefusalFor,
  refusalsForSources,
  suppressedCountsForSources,
  verificationsForMemories,
} from '../ingestion/index';
import { ProjectService } from '../projects/index';
import { FileReadReportStore, readOutcomesForKeys } from '../files/index';
import type { ReadLocator } from '../files/index';
import { listNoteSources, hydrateNoteSources } from '../notes/index';
import { listEmailSources, hydrateEmailSources } from '../email/index';
import { listWebSources, hydrateWebSources } from '../research/index';
import { hydrateChatSources } from '../chat/index';
import { ImportService } from '../imports/index';
import type { FindingsReportRow } from './persistence/tables';
import {
  rateString,
  sanitizeReportText,
  type ReportChainLink,
  type ReportCoverageSource,
  type ReportFinding,
  type ReportLocator,
  type ReportPayload,
  type ReportSourceRef,
  type ReportSuppressedEntry,
  type ReportTrustMetrics,
} from './report-format';
import { REPORT_OPTIONS } from './report.options';
import type { ReportOptions } from './report.options';

/** Read outcomes that mean the source produced no text (the catalog's rule). */
const UNREAD_OUTCOMES = ['empty', 'unsupported_format', 'read_failed', 'needs_vision'] as const;

/** Enumeration bound, STATED in the payload — never a silent truncation. */
export const SCOPE_SOURCE_LIMIT = 1000;
/** Superseded-chain bound, stated in the payload. */
export const CHAIN_LIMIT = 100;
/** Suppressed-entry bound, stated in the payload (counts are always total). */
export const SUPPRESSED_ENTRY_LIMIT = 200;

interface ScopeSource {
  sourceType: SourceType;
  sourceId: string;
  name: string | null;
  at: Date | null;
}

export interface AssembledReport {
  payload: ReportPayload;
  counts: FindingsReportCountsDto;
}

/**
 * The findings-run assembler (V2.3 item 6.2, issue B): reads everything the
 * report states through the owning modules' PUBLIC, Principal-gated
 * interfaces — the sources/ composition precedent, worker-side — and builds
 * the payload whose every number traces to a stored row.
 *
 * Honesty rules enforced here rather than at rendering:
 * - every bound is stated (`scope_truncated`, `chains_limit`, ...);
 * - sensitive facts are withheld from a forwardable artifact and COUNTED;
 * - a span recovered by OCR or vision says so on the finding;
 * - absent trust scores for the configuration are stated as absent, never
 *   borrowed from another configuration.
 */
@Injectable()
export class ReportAssembler {
  private readonly logger = new Logger(ReportAssembler.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly memory: MemoryStore,
    private readonly reconciliation: MemoryReconciliation,
    private readonly objects: MemoryObjectStore,
    private readonly suppressed: SuppressedFactLog,
    private readonly contexts: SourceContextStore,
    private readonly revisions: SourceRevisionStore,
    private readonly readReports: FileReadReportStore,
    private readonly imports: ImportService,
    @Inject(REPORT_OPTIONS) private readonly options: ReportOptions,
    /** Projects (V2.5 item 8.3): a project scope's source enumeration and
     * the name the report states. Optional so a bare harness assembles the
     * four pre-existing scope kinds unchanged. */
    @Optional() private readonly projects?: ProjectService,
  ) {}

  async assemble(
    principal: Principal,
    run: FindingsReportRow,
    previous: FindingsReportRow | null,
    onProgress: (done: number, total: number) => Promise<void>,
  ): Promise<AssembledReport> {
    // ── Scope enumeration ──────────────────────────────────────────────────
    const scope = run.scopeJson;
    const skippedRefs: ReportPayload['coverage']['skipped_refs'] = [];
    let importCounts: ReportPayload['coverage']['import_counts'] = null;
    let sources: ScopeSource[] = [];
    let scopeTruncated = false;

    if (scope.kind === 'import') {
      const detail = await this.imports.detail(principal, scope.importRunId);
      const items = detail.items ?? [];
      for (const item of items) {
        if ((item.state === 'ingested' || item.state === 'tombstoned') && item.objectKey) {
          sources.push({
            sourceType: 'file',
            sourceId: item.objectKey,
            name: item.name,
            at: null,
          });
        }
      }
      const counts = detail.counts;
      importCounts = {
        documents: counts?.documents ?? items.filter((i) => i.state === 'ingested').length,
        duplicates_skipped: counts?.duplicatesSkipped ?? 0,
        unreadable: counts?.unreadable ?? 0,
        failed: counts?.failed ?? 0,
        excluded: counts?.excluded ?? 0,
        unsupported: counts?.unsupported ?? 0,
      };
    } else if (scope.kind === 'project' || scope.kind === 'sources') {
      // A project scope enumerates EXACTLY that project's source
      // assignments (V2.5 item 8.3 issue C2), which is what makes a
      // client-facing report structurally free of another client's
      // documents; from there it is the sources scope's own path, ownership
      // check and skipped-ref reporting included.
      const refs =
        scope.kind === 'project'
          ? ((await this.projects?.sourceRefsFor(scope.projectId, SCOPE_SOURCE_LIMIT)) ?? [])
          : scope.refs;
      for (const ref of refs) {
        if (!isRegisteredSourceType(ref.sourceType)) {
          skippedRefs.push({
            source_type: ref.sourceType,
            source_id: ref.sourceId,
            reason: 'unknown_source_type',
          });
          continue;
        }
        const owned = await this.ownsSource(principal, ref.sourceType as SourceType, ref.sourceId);
        if (!owned) {
          skippedRefs.push({
            source_type: ref.sourceType,
            source_id: ref.sourceId,
            reason: 'not_found_or_not_owned',
          });
          continue;
        }
        sources.push({
          sourceType: ref.sourceType as SourceType,
          sourceId: ref.sourceId,
          name: null,
          at: null,
        });
      }
    } else {
      const enumerated = await this.enumerateCorpus(principal);
      sources = enumerated.sources;
      scopeTruncated = enumerated.stalled;
      if (scope.kind === 'date_range') {
        const from = new Date(scope.from).getTime();
        const to = new Date(scope.to).getTime();
        sources = sources.filter(
          (s) => s.at !== null && s.at.getTime() >= from && s.at.getTime() <= to,
        );
      }
    }
    if (sources.length > SCOPE_SOURCE_LIMIT) {
      sources = sources.slice(0, SCOPE_SOURCE_LIMIT);
      scopeTruncated = true;
    }
    // The project's own name goes ON the report (V2.5 item 8.3): a
    // client-facing artifact that does not say which client it is about is
    // half an artifact. The user's own words, never source-derived, and
    // sanitized like every other text that reaches the canonical bytes.
    const projectName =
      scope.kind === 'project'
        ? ((await this.projects?.get(principal, scope.projectId).catch(() => null))?.name ?? null)
        : null;
    await onProgress(0, sources.length);

    // ── Per-source grouped reads (one query per family per batch) ──────────
    const refs = sources.map((s) => ({ sourceType: s.sourceType, sourceId: s.sourceId }));
    const fileKeys = sources.filter((s) => s.sourceType === 'file').map((s) => s.sourceId);
    const [factStats, suppressedCounts, refusals, outcomes] = await Promise.all([
      this.memory.sourceFactStatsForRefs(principal, refs),
      suppressedCountsForSources(this.db, principal, refs),
      refusalsForSources(this.db, refs),
      readOutcomesForKeys(this.db, fileKeys),
    ]);

    // Names, anchoring context and read detail per source (bounded by the
    // stated scope cap; each is a keyed read).
    const contextBySource = new Map<
      string,
      { documentClass: string | null; revision: string | null; subjects: { name: string }[] }
    >();
    const readDetail = new Map<string, Awaited<ReturnType<FileReadReportStore['get']>>>();
    let done = 0;
    for (const source of sources) {
      const key = keyOf(source.sourceType, source.sourceId);
      if (source.sourceType === 'file') {
        const [context, detail] = await Promise.all([
          this.contexts
            .getForOwner(principal, source.sourceType, source.sourceId)
            .catch(() => null),
          this.readReports.get(source.sourceId),
        ]);
        if (context) {
          contextBySource.set(key, {
            documentClass: context.documentClass,
            revision: context.revision,
            subjects: context.subjects ?? [],
          });
        }
        if (detail) readDetail.set(key, detail);
        if (source.name === null) {
          source.name = await this.fileName(source.sourceId, contextBySource.get(key));
        }
      } else if (source.name === null) {
        source.name = await this.hydrateName(principal, source.sourceType, source.sourceId);
      }
      done += 1;
      if (done % 25 === 0) await onProgress(done, sources.length);
    }

    // Sources OUTSIDE the scope that a finding or chain references still need
    // a display name (the reader must be able to open both documents), but
    // they were not examined: they live in this separate map and never join
    // the coverage rows, the counts, or the scope cap.
    const referencedSources = new Map<string, { name: string | null }>();
    const sourceRefFor = (sourceType: string, sourceId: string): ReportSourceRef => {
      const key = keyOf(sourceType, sourceId);
      const inScope = sources.find((s) => s.sourceType === sourceType && s.sourceId === sourceId);
      const context = contextBySource.get(key);
      return {
        source_type: sourceType,
        source_id: sourceId,
        name: inScope?.name ?? referencedSources.get(key)?.name ?? null,
        document_class: context?.documentClass ?? null,
        revision: context?.revision ?? null,
      };
    };

    // ── Findings ───────────────────────────────────────────────────────────
    let sensitiveWithheld = 0;
    const findingsByRelation = new Map<
      string,
      { relation: RelationRow; a: MemoryRow; b: MemoryRow }
    >();
    for (const source of sources) {
      const rows = await this.reconciliation.contradictionsForSource(
        principal,
        source.sourceType,
        source.sourceId,
        { includeResolved: true },
      );
      for (const row of rows) {
        findingsByRelation.set(row.relation.id, row as never);
      }
    }
    // Withhold findings with a sensitive party from the forwardable artifact.
    for (const [id, { a, b }] of [...findingsByRelation]) {
      if (a.sensitive || b.sensitive) {
        findingsByRelation.delete(id);
        sensitiveWithheld += 1;
      }
    }
    const relationIds = [...findingsByRelation.keys()];
    const partyIds = [...findingsByRelation.values()].flatMap(({ a, b }) => [a.id, b.id]);
    const [verifications, events] = await Promise.all([
      verificationsForMemories(this.db, partyIds),
      this.reconciliation.eventsForRelations(principal, relationIds),
    ]);

    // Party sources outside the scope still need names + context: the reader
    // must be able to open BOTH documents.
    for (const { a, b } of findingsByRelation.values()) {
      for (const party of [a, b]) {
        await this.ensureNamed(
          principal,
          party.sourceType,
          party.sourceId,
          sources,
          referencedSources,
          contextBySource,
        );
      }
    }

    const findings: ReportFinding[] = [];
    for (const { relation, a, b } of findingsByRelation.values()) {
      const history = (events.get(relation.id) ?? []).map((event) => ({
        event: event.event,
        at: event.createdAt.toISOString(),
        detail: (event.detailJson as Record<string, unknown> | null) ?? null,
      }));
      const reopened = relation.resolvedAt === null && history.some((e) => e.event === 'reopened');
      const resolvedByRevision =
        relation.resolution === 'revision'
          ? await this.revisionResolution(principal, history, sourceRefFor)
          : null;
      findings.push({
        id: relation.id,
        detected_at: relation.detectedAt.toISOString(),
        detected_by: relation.detectedBy ?? null,
        state: relation.resolvedAt ? 'resolved' : 'open',
        reopened,
        resolution: relation.resolution ?? null,
        resolved_at: relation.resolvedAt?.toISOString() ?? null,
        resolved_by_revision: resolvedByRevision,
        explanation: relation.reason ? sanitizeReportText(relation.reason) : null,
        parties: [
          this.party(a, verifications.get(a.id), sourceRefFor),
          this.party(b, verifications.get(b.id), sourceRefFor),
        ],
        history,
      });
    }

    // Group by subject entity: a conflict is about a subject, not owned by
    // either document, so all evidence about one question lands together.
    // Ordering is stable: groups alphabetically (unattributed last), findings
    // by detection time then id.
    const groups = new Map<string, { subject: string | null; findings: ReportFinding[] }>();
    for (const finding of findings) {
      const { a, b } = findingsByRelation.get(finding.id)!;
      const subject = a.subjectEntity ?? b.subjectEntity ?? null;
      const groupKey = subject ? subject.trim().toLowerCase() : '￿';
      const group = groups.get(groupKey) ?? { subject, findings: [] };
      group.findings.push(finding);
      groups.set(groupKey, group);
    }
    const sortedGroups = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, group]) => ({
        subject: group.subject,
        findings: group.findings.sort((x, y) =>
          x.detected_at === y.detected_at
            ? x.id < y.id
              ? -1
              : 1
            : x.detected_at < y.detected_at
              ? -1
              : 1,
        ),
      }));

    // ── Superseded chains ──────────────────────────────────────────────────
    const chains: { links: ReportChainLink[] }[] = [];
    const chainHeads = new Set<string>();
    let chainsTruncated = false;
    outer: for (const source of sources) {
      const replaced = await this.memory.listForPrincipal(principal, {
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        status: 'replaced',
        limit: 200,
      });
      for (const fact of replaced) {
        const chain = await this.memory.getChain(principal, fact.id);
        if (chain.length < 2) continue;
        const headId = chain[0]!.id;
        if (chainHeads.has(headId)) continue;
        chainHeads.add(headId);
        if (chain.some((row) => row.sensitive)) {
          sensitiveWithheld += 1;
          continue;
        }
        if (chains.length >= CHAIN_LIMIT) {
          chainsTruncated = true;
          break outer;
        }
        for (const row of chain) {
          await this.ensureNamed(
            principal,
            row.sourceType,
            row.sourceId,
            sources,
            referencedSources,
            contextBySource,
          );
        }
        chains.push({
          links: chain.map((row) => ({
            memory_id: row.id,
            content: sanitizeReportText(row.content ?? ''),
            status: row.status ?? 'active',
            valid_from: row.validFrom?.toISOString() ?? null,
            valid_until: row.validUntil?.toISOString() ?? null,
            recorded_at: row.createdAt.toISOString(),
            source: sourceRefFor(row.sourceType, row.sourceId),
          })),
        });
      }
    }
    // Newest correction first; head id ties the order down.
    chains.sort((x, y) => {
      const lastX = x.links[x.links.length - 1]!.recorded_at;
      const lastY = y.links[y.links.length - 1]!.recorded_at;
      if (lastX !== lastY) return lastX > lastY ? -1 : 1;
      return x.links[0]!.memory_id < y.links[0]!.memory_id ? -1 : 1;
    });

    // ── Suppressed facts ───────────────────────────────────────────────────
    const suppressedSection = await this.suppressedSection(
      principal,
      scope.kind === 'corpus' || scope.kind === 'date_range' ? null : refs,
      sourceRefFor,
      (n) => {
        sensitiveWithheld += n;
      },
    );

    // ── Trust scores for the configuration ─────────────────────────────────
    const trust = await this.trustScoresFor(this.options.modelConfig.id);

    // ── Delta ──────────────────────────────────────────────────────────────
    const prevAt = previous?.createdAt ?? null;
    const resolvedSince = prevAt
      ? findings.filter((f) => f.resolved_at !== null && f.resolved_at > prevAt.toISOString())
          .length
      : null;
    const newSince = prevAt
      ? findings.filter((f) => f.detected_at > prevAt.toISOString()).length
      : null;
    const reopenedSince = prevAt
      ? findings.filter(
          (f) =>
            f.state === 'open' &&
            f.history.some((e) => e.event === 'reopened' && e.at > prevAt.toISOString()),
        ).length
      : null;

    // ── Coverage + summary ─────────────────────────────────────────────────
    const coverageSources: ReportCoverageSource[] = sources.map((source) => {
      const key = keyOf(source.sourceType, source.sourceId);
      const outcome = source.sourceType === 'file' ? outcomes.get(source.sourceId) : undefined;
      const detail = readDetail.get(key);
      const pages = detail?.pages ?? [];
      const refusalReason = refusals.get(key);
      return {
        source: sourceRefFor(source.sourceType, source.sourceId),
        first_seen_at: source.at?.toISOString() ?? null,
        facts: factStats.get(key)?.facts ?? 0,
        suppressed: suppressedCounts.get(key) ?? 0,
        read: outcome
          ? {
              outcome: outcome.outcome,
              reason_code: outcome.reasonCode ?? null,
              pages_total: pages.length > 0 ? pages.length : null,
              pages_ocr: pages.filter((p) => p.tier === 'ocr').length,
              pages_vision: pages.filter((p) => p.tier === 'vision').length,
              sheets_truncated: (detail?.sheets ?? []).filter((s) => s.truncated).length,
              rows_read: sumOrNull(detail?.sheets?.map((s) => s.rowsRead)),
              rows_total: sumOrNull(detail?.sheets?.map((s) => s.rowsTotal)),
            }
          : null,
        gate_refusal: refusalReason ? { reason: refusalReason, refused_at: null } : null,
      };
    });
    // Refusal timestamps for the refused few (keyed read each).
    for (const entry of coverageSources) {
      if (entry.gate_refusal) {
        const refusal = await latestGateRefusalFor(this.db, {
          sourceType: entry.source.source_type,
          sourceId: entry.source.source_id,
        });
        entry.gate_refusal = refusal
          ? { reason: refusal.reason, refused_at: refusal.refusedAt?.toISOString() ?? null }
          : entry.gate_refusal;
      }
    }

    const unreadable = coverageSources.filter(
      (c) => c.read && (UNREAD_OUTCOMES as readonly string[]).includes(c.read.outcome),
    ).length;
    const truncated = coverageSources.filter((c) => c.read?.outcome === 'truncated').length;
    const factsTotal = coverageSources.reduce((sum, c) => sum + c.facts, 0);
    const supersededTotal = [...factStats.values()].reduce((sum, s) => sum + s.superseded, 0);
    const openCount = findings.filter((f) => f.state === 'open').length;
    const resolvedCount = findings.length - openCount;

    const seenDates = sources.map((s) => s.at).filter((d): d is Date => d !== null);
    const dateRange = {
      from: seenDates.length
        ? new Date(Math.min(...seenDates.map((d) => d.getTime()))).toISOString()
        : null,
      to: seenDates.length
        ? new Date(Math.max(...seenDates.map((d) => d.getTime()))).toISOString()
        : null,
    };

    const counts: FindingsReportCountsDto = {
      sourcesExamined: sources.length,
      sourcesUnreadable: unreadable,
      sourcesTruncated: truncated,
      gateRefusals: coverageSources.filter((c) => c.gate_refusal).length,
      facts: factsTotal,
      findingsOpen: openCount,
      findingsResolved: resolvedCount,
      supersededFacts: supersededTotal,
      suppressedFacts: suppressedSection.total,
      resolvedSincePrevious: resolvedSince,
      newSincePrevious: newSince,
      reopenedSincePrevious: reopenedSince,
    };

    const payload: ReportPayload = {
      report: {
        id: run.id,
        version: FINDINGS_REPORT_VERSION,
        generated_at: run.createdAt.toISOString(),
        locale: run.locale,
        scope: {
          kind: scope.kind,
          import_run_id: scope.kind === 'import' ? scope.importRunId : null,
          // A project scope lists what it actually examined, exactly as a
          // sources scope does: the report states its scope, and a finding
          // count means nothing without knowing what was looked at.
          refs:
            scope.kind === 'sources'
              ? scope.refs.map((r) => ({ source_type: r.sourceType, source_id: r.sourceId }))
              : scope.kind === 'project'
                ? sources.map((r) => ({ source_type: r.sourceType, source_id: r.sourceId }))
                : null,
          project_id: scope.kind === 'project' ? scope.projectId : null,
          project_name: projectName,
          from: scope.kind === 'date_range' ? scope.from : null,
          to: scope.kind === 'date_range' ? scope.to : null,
        },
        date_range: dateRange,
        previous_report: previous
          ? { id: previous.id, generated_at: previous.createdAt.toISOString() }
          : null,
        public_key_endpoint: '/api/instance/public-key',
      },
      configuration: {
        id: this.options.modelConfig.id,
        tiers: this.options.modelConfig.tiers,
        vision: this.options.modelConfig.vision,
        redaction_enabled: this.options.modelConfig.redactionEnabled,
        prompt_versions: ACTIVE_PROMPTS.map((p) => ({ family: p.family, version: p.version })),
        reconcile_config_version: RECONCILE_CONFIG_VERSION,
        trust_scores: trust,
      },
      summary: {
        sources_examined: counts.sourcesExamined,
        facts_extracted: counts.facts,
        findings_open: counts.findingsOpen,
        findings_resolved: counts.findingsResolved,
        resolved_since_previous: counts.resolvedSincePrevious,
        new_since_previous: counts.newSincePrevious,
        reopened_since_previous: counts.reopenedSincePrevious,
        sources_not_fully_read: unreadable + truncated,
        facts_withheld: suppressedSection.total,
        superseded_facts: supersededTotal,
        gate_refusals: counts.gateRefusals,
        sensitive_facts_excluded: sensitiveWithheld,
      },
      coverage: {
        sources: coverageSources,
        skipped_refs: skippedRefs,
        scope_truncated: scopeTruncated,
        scope_limit: SCOPE_SOURCE_LIMIT,
        import_counts: importCounts,
      },
      findings: {
        grouping: 'subject_entity',
        groups: sortedGroups,
      },
      superseded: {
        chains,
        chains_truncated: chainsTruncated,
        chains_limit: CHAIN_LIMIT,
      },
      suppressed: suppressedSection,
    };

    await onProgress(sources.length, sources.length);
    return { payload, counts };
  }

  // ── Pieces ───────────────────────────────────────────────────────────────

  private party(
    row: MemoryRow,
    verification:
      | {
          sourceSpan: string | null;
          hedgePhrase: string | null;
          spanLocators: ReadLocator[] | null;
        }
      | undefined,
    sourceRefFor: (sourceType: string, sourceId: string) => ReportSourceRef,
  ): ReportFinding['parties'][number] {
    const locators = verification?.spanLocators ?? null;
    const mapped = locators ? locators.map(toReportLocator) : null;
    const recovered = mapped?.some((l) => l.kind === 'page' && l.tier === 'vision')
      ? ('vision' as const)
      : mapped?.some((l) => l.kind === 'page' && l.tier === 'ocr')
        ? ('ocr' as const)
        : null;
    return {
      memory_id: row.id,
      claim: sanitizeReportText(row.content ?? ''),
      status: row.status ?? 'active',
      kind: row.kind ?? 'fact',
      valid_from: row.validFrom?.toISOString() ?? null,
      valid_until: row.validUntil?.toISOString() ?? null,
      source: sourceRefFor(row.sourceType, row.sourceId),
      span: verification?.sourceSpan
        ? {
            text: sanitizeReportText(verification.sourceSpan),
            locators: mapped,
            recovered_by: recovered,
            hedge: verification.hedgePhrase,
          }
        : null,
    };
  }

  /** The revision that settled a finding, from its event log's structural
   * detail: the successor memory names the responsible document. */
  private async revisionResolution(
    principal: Principal,
    history: { event: string; detail: Record<string, unknown> | null }[],
    sourceRefFor: (sourceType: string, sourceId: string) => ReportSourceRef,
  ): Promise<ReportFinding['resolved_by_revision']> {
    const event = [...history].reverse().find((e) => e.event === 'resolved_by_revision');
    if (!event?.detail) return { source_revision_id: null, successor_source: null };
    const revisionId =
      typeof event.detail['source_revision'] === 'string'
        ? (event.detail['source_revision'] as string)
        : null;
    const successorId =
      typeof event.detail['successor'] === 'string' ? (event.detail['successor'] as string) : null;
    let successorSource: ReportSourceRef | null = null;
    if (successorId) {
      const successor = await this.memory.getForPrincipal(principal, successorId, {
        includeSensitive: true,
      });
      if (successor) successorSource = sourceRefFor(successor.sourceType, successor.sourceId);
    }
    return { source_revision_id: revisionId, successor_source: successorSource };
  }

  private async suppressedSection(
    principal: Principal,
    scopeRefs: { sourceType: string; sourceId: string }[] | null,
    sourceRefFor: (sourceType: string, sourceId: string) => ReportSourceRef,
    onSensitiveWithheld: (n: number) => void,
  ): Promise<ReportPayload['suppressed']> {
    const byReason: Record<string, number> = {};
    const entries: ReportSuppressedEntry[] = [];
    let total = 0;
    let withheld = 0;

    const collect = (rows: SuppressedRowLike[]) => {
      for (const row of rows) {
        if (row.sensitive) {
          withheld += 1;
          continue;
        }
        if (entries.length >= SUPPRESSED_ENTRY_LIMIT) continue;
        entries.push({
          reason: row.reason,
          fact_content: sanitizeReportText(row.factContent),
          span_text: row.sourceSpan ? sanitizeReportText(row.sourceSpan) : null,
          locators: row.spanLocators ? row.spanLocators.map(toReportLocator) : null,
          verification_verdict: row.verificationVerdict ?? null,
          source: sourceRefFor(row.sourceType, row.sourceId),
          created_at: row.createdAt.toISOString(),
        });
      }
    };

    if (scopeRefs === null) {
      const summary = await this.suppressed.summarize(principal, {});
      total = summary.total;
      for (const [reason, count] of Object.entries(summary.byReason)) {
        if (count > 0) byReason[reason] = count;
      }
      const page = await this.suppressed.list(principal, { limit: SUPPRESSED_ENTRY_LIMIT });
      collect(page.items as unknown as SuppressedRowLike[]);
    } else {
      for (const ref of scopeRefs) {
        // Page the WHOLE per-source log for the by-reason counts (bounded,
        // and the bound is far above any real source), so the stated total
        // and the by-reason table cannot disagree; only the ENTRIES list is
        // capped, and it says so.
        let offset = 0;
        for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
          const page = await this.suppressed.list(principal, {
            sourceType: ref.sourceType,
            sourceId: ref.sourceId,
            limit: SUPPRESSED_ENTRY_LIMIT,
            offset,
          });
          if (offset === 0) total += page.total;
          for (const row of page.items as unknown as SuppressedRowLike[]) {
            byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
          }
          collect(page.items as unknown as SuppressedRowLike[]);
          offset += page.items.length;
          if (offset >= page.total || page.items.length === 0) break;
        }
      }
    }
    onSensitiveWithheld(withheld);
    return {
      total,
      by_reason: byReason,
      entries,
      entries_truncated: total > entries.length + withheld,
      entries_limit: SUPPRESSED_ENTRY_LIMIT,
    };
  }

  /**
   * Published trust scores for THIS configuration, from the bundled artifacts.
   * A missing directory, an unreadable index, or no artifact whose
   * configuration id matches (with or without the probed `--reasoning`
   * marker) all land on `not_published`: measured accuracy is never borrowed
   * from a different configuration.
   */
  private async trustScoresFor(
    configurationId: string,
  ): Promise<ReportPayload['configuration']['trust_scores']> {
    const result = await readTrustScoresFor(this.options.trustScoresDir, configurationId);
    if (result.status === 'not_published') {
      this.logger.log(
        `no published trust scores match configuration ${configurationId}: the report states so`,
      );
    }
    return result;
  }

  // ── Enumeration helpers (the catalog's shapes, exhaustively paged) ──────

  private async enumerateCorpus(
    principal: Principal,
  ): Promise<{ sources: ScopeSource[]; stalled: boolean }> {
    const out = new Map<string, ScopeSource>();
    let stalled = false;
    const push = (s: ScopeSource) => out.set(keyOf(s.sourceType, s.sourceId), s);

    stalled =
      (await this.drain(
        (cursor) => listNoteSources(this.db, principal.userId, pageOpts(cursor)),
        (row) =>
          push({ sourceType: 'user_note', sourceId: row.sourceId, name: row.name, at: row.at }),
      )) || stalled;
    stalled =
      (await this.drain(
        (cursor) => listEmailSources(this.db, principal.userId, pageOpts(cursor)),
        (row) => push({ sourceType: 'email', sourceId: row.sourceId, name: row.name, at: row.at }),
      )) || stalled;
    stalled =
      (await this.drain(
        (cursor) => listWebSources(this.db, principal.userId, pageOpts(cursor)),
        (row) => push({ sourceType: 'web', sourceId: row.sourceId, name: row.name, at: row.at }),
      )) || stalled;
    // Chat captures enumerate from their facts' provenance.
    stalled =
      (await this.drain(
        async (cursor) => {
          const refs = await this.memory.listSourceRefsForPrincipal(principal, {
            ...pageOpts(cursor),
            sourceType: 'chat',
          });
          return refs.map((r) => ({ sourceId: r.sourceId, name: null, at: r.firstAt }));
        },
        (row) => push({ sourceType: 'chat', sourceId: row.sourceId, name: row.name, at: row.at }),
      )) || stalled;
    // Files: stored uploads plus discard-mode sources whose only trace is
    // their facts' provenance; metadata rows win the date.
    stalled =
      (await this.drain(
        async (cursor) => {
          const refs = await this.memory.listSourceRefsForPrincipal(principal, {
            ...pageOpts(cursor),
            sourceType: 'file',
          });
          return refs.map((r) => ({ sourceId: r.sourceId, name: null, at: r.firstAt }));
        },
        (row) => push({ sourceType: 'file', sourceId: row.sourceId, name: row.name, at: row.at }),
      )) || stalled;
    stalled =
      (await this.drain(
        async (cursor) => {
          const rows = await listFileSourceRefs(this.db, principal.userId, pageOpts(cursor));
          return rows.map((r) => ({ sourceId: r.objectKey, name: null, at: r.at }));
        },
        (row) => push({ sourceType: 'file', sourceId: row.sourceId, name: row.name, at: row.at }),
      )) || stalled;

    const sorted = [...out.values()].sort((a, b) => {
      const at = a.at?.getTime() ?? 0;
      const bt = b.at?.getTime() ?? 0;
      if (at !== bt) return bt - at;
      return a.sourceId < b.sourceId ? -1 : 1;
    });
    return { sources: sorted, stalled };
  }

  /**
   * Exhausts a cursor-paged listing up to the scope cap. The listings page on
   * a strictly-greater timestamp cursor, so a full page ending in a run of
   * identical timestamps cannot advance; that stall is RETURNED and lands on
   * the report as scope truncation, never a silent omission.
   */
  private async drain(
    page: (
      cursor: Date | undefined,
    ) => Promise<{ sourceId: string; name: string | null; at: Date }[]>,
    push: (row: { sourceId: string; name: string | null; at: Date }) => void,
  ): Promise<boolean> {
    let cursor: Date | undefined;
    for (let i = 0; i < Math.ceil((SCOPE_SOURCE_LIMIT + 1) / PAGE_SIZE) + 1; i += 1) {
      const rows = await page(cursor);
      for (const row of rows) push(row);
      if (rows.length < PAGE_SIZE) return false;
      const last = rows[rows.length - 1]!.at;
      if (cursor && last.getTime() === cursor.getTime()) return true;
      cursor = last;
    }
    return true;
  }

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
    return false;
  }

  private async hydrateName(
    principal: Principal,
    sourceType: SourceType,
    sourceId: string,
  ): Promise<string | null> {
    if (sourceType === 'user_note') {
      return (
        (await hydrateNoteSources(this.db, principal.userId, [sourceId])).get(sourceId)?.name ??
        null
      );
    }
    if (sourceType === 'email') {
      return (
        (await hydrateEmailSources(this.db, principal.userId, [sourceId])).get(sourceId)?.name ??
        null
      );
    }
    if (sourceType === 'web') {
      return (
        (await hydrateWebSources(this.db, principal.userId, [sourceId])).get(sourceId)?.name ?? null
      );
    }
    if (sourceType === 'chat') {
      return (
        (await hydrateChatSources(this.db, principal.userId, [sourceId])).get(sourceId)?.name ??
        null
      );
    }
    return null;
  }

  /** Filename from the object's metadata, else the anchored first subject. */
  private async fileName(
    objectKey: string,
    context: { subjects: { name: string }[] } | undefined,
  ): Promise<string | null> {
    const stat = await this.objects.statObject(objectKey).catch(() => null);
    const raw = stat?.metadata['original-filename'];
    if (raw) {
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
    return context?.subjects?.[0]?.name ?? null;
  }

  /** A source referenced by a finding or chain but outside the scope still
   * gets a name and context: the reader must be able to open the document. */
  private async ensureNamed(
    principal: Principal,
    sourceType: SourceType,
    sourceId: string,
    sources: ScopeSource[],
    referencedSources: Map<string, { name: string | null }>,
    contextBySource: Map<
      string,
      { documentClass: string | null; revision: string | null; subjects: { name: string }[] }
    >,
  ): Promise<void> {
    const existing = sources.find((s) => s.sourceType === sourceType && s.sourceId === sourceId);
    if (existing?.name) return;
    const key = keyOf(sourceType, sourceId);
    if (!existing && referencedSources.has(key)) return;
    if (sourceType === 'file' && !contextBySource.has(key)) {
      const context = await this.contexts
        .getForOwner(principal, sourceType, sourceId)
        .catch(() => null);
      if (context) {
        contextBySource.set(key, {
          documentClass: context.documentClass,
          revision: context.revision,
          subjects: context.subjects ?? [],
        });
      }
    }
    const name =
      sourceType === 'file'
        ? await this.fileName(sourceId, contextBySource.get(key))
        : await this.hydrateName(principal, sourceType, sourceId);
    if (existing) {
      existing.name = name;
    } else {
      // NEVER pushed into the examined scope: coverage rows and counts were
      // computed from the scope snapshot, and a referenced document was not
      // examined.
      referencedSources.set(key, { name });
    }
  }
}

const PAGE_SIZE = 100;

function pageOpts(cursor: Date | undefined): {
  cursor?: Date;
  order: 'asc';
  limit: number;
} {
  return { ...(cursor ? { cursor } : {}), order: 'asc', limit: PAGE_SIZE };
}

function keyOf(sourceType: string, sourceId: string): string {
  return `${sourceType} ${sourceId}`;
}

function sumOrNull(values: number[] | undefined): number | null {
  if (!values || values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0);
}

function toReportLocator(locator: ReadLocator): ReportLocator {
  if (locator.kind === 'page') {
    return { kind: 'page', page: locator.page, tier: locator.tier ?? 'text' };
  }
  if (locator.kind === 'paragraph') {
    return { kind: 'paragraph', paragraph: locator.paragraph };
  }
  if (locator.kind === 'sheet_row') {
    return {
      kind: 'sheet_row',
      sheet: locator.sheet,
      sheet_index: locator.sheetIndex,
      row: locator.row,
      cell_range: locator.cellRange,
      columns: locator.columns,
    };
  }
  return { kind: 'document' };
}

/**
 * Published trust scores for THIS configuration, from the bundled artifacts
 * (newest release first). A missing directory, an unreadable index, or no
 * entry whose id matches (with or without the probed `--reasoning` marker)
 * all land on `not_published`: measured accuracy is never borrowed from a
 * different configuration. Exported pure so the published-artifact shape is
 * pinned by a test against the real files in eval/trust-scores.
 */
export async function readTrustScoresFor(
  trustScoresDir: string,
  configurationId: string,
): Promise<ReportPayload['configuration']['trust_scores']> {
  const notPublished = {
    status: 'not_published' as const,
    release: null,
    matched_configuration_id: null,
    generated_at: null,
    aggregate: null,
    per_language: null,
  };
  let index: { version: string; path: string }[];
  try {
    const raw = await readFile(join(trustScoresDir, 'index.json'), 'utf8');
    index = JSON.parse(raw) as { version: string; path: string }[];
  } catch {
    return notPublished;
  }
  const accepted = new Set([configurationId, `${configurationId}--reasoning`]);
  for (const entry of index) {
    let doc: TrustScoresFile;
    try {
      const raw = await readFile(join(trustScoresDir, entry.path), 'utf8');
      doc = JSON.parse(raw) as TrustScoresFile;
    } catch {
      continue;
    }
    const matched = (doc.configurations ?? []).find(
      (candidate) => candidate.id !== undefined && accepted.has(candidate.id),
    );
    if (!matched) continue;
    const metrics = matched.metrics;
    return {
      status: 'published',
      release: entry.version,
      matched_configuration_id: matched.id ?? null,
      generated_at: doc.generated_by?.generated_at ?? null,
      aggregate: metrics?.aggregate ? toTrustMetrics(metrics.aggregate) : null,
      per_language: metrics?.per_language
        ? metrics.per_language.map((lang) => ({
            language: lang.language ?? '',
            ...toTrustMetrics(lang),
          }))
        : null,
    };
  }
  return notPublished;
}

function toTrustMetrics(raw: TrustMetricsRaw): ReportTrustMetrics {
  return {
    extraction_precision: rateString(raw.extraction_precision),
    extraction_recall: rateString(raw.extraction_recall),
    verification_agreement: rateString(raw.verification_agreement),
    dedup_accuracy: rateString(raw.dedup_accuracy),
    contradiction_recall: rateString(raw.contradiction_recall),
    contradiction_precision: rateString(raw.contradiction_precision),
    supersedes_accuracy: rateString(raw.supersedes_accuracy),
    supersedes_pairs: raw.supersedes_pairs ?? null,
    rewrite_accuracy: rateString(raw.rewrite_accuracy),
  };
}

interface TrustMetricsRaw {
  extraction_precision?: number | null;
  extraction_recall?: number | null;
  verification_agreement?: number | null;
  dedup_accuracy?: number | null;
  contradiction_recall?: number | null;
  contradiction_precision?: number | null;
  supersedes_accuracy?: number | null;
  supersedes_pairs?: number | null;
  rewrite_accuracy?: number | null;
  language?: string;
}

/** The published trust-scores document (schema 1.x): one entry per measured
 * configuration, matched here by its exact id. */
interface TrustScoresFile {
  generated_by?: { generated_at?: string };
  configurations?: {
    id?: string;
    metrics?: {
      aggregate?: TrustMetricsRaw;
      per_language?: TrustMetricsRaw[];
    };
  }[];
}

interface SuppressedRowLike {
  reason: string;
  factContent: string;
  sourceSpan: string | null;
  spanLocators: ReadLocator[] | null;
  verificationVerdict: string | null;
  sourceType: string;
  sourceId: string;
  sensitive: boolean;
  createdAt: Date;
}

interface RelationRow {
  id: string;
  detectedAt: Date;
  detectedBy: string | null;
  resolvedAt: Date | null;
  resolution: string | null;
  reason: string | null;
}
