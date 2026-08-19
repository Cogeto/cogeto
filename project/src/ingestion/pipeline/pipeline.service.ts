import { Inject, Injectable, Optional } from '@nestjs/common';
import { locateSpan, SOURCE_TYPES, sourceTypeDescriptor } from '@cogeto/shared';
import type { ReadLocator, ReadSegment } from '@cogeto/shared';
import {
  acquireJobRunLock,
  DEFAULT_PARSE_CAPS,
  PARSE_CAPS,
  withTransactionalEnqueue,
  writeAudit,
} from '../../infrastructure/index';
import type { ParseCaps, Tx } from '../../infrastructure/index';
import type { MemoryReconciliation, MemoryStore } from '../../memory/index';
import type { ModelGateway } from '../../model-gateway/index';
import { structurallyValid } from '../domain/uncertainty';
import { UserDirectory } from '../../identity/index';
import { ExtractionGateStore } from '../persistence/extraction-gate.store';
import { PROJECT_POLICY } from '../project-policy.port';
import type { ProjectPolicyPort } from '../project-policy.port';
import { IngestionProgressStore } from '../persistence/ingestion-progress';
import { AnchorStage } from './anchor.stage';
import { SuppressedFactLog } from '../persistence/suppressed-fact-log';
import type { SuppressedFactEntry } from '../persistence/suppressed-fact-log';
import { chunkContent } from './chunk';
import { EmbedStoreStage } from './embed-store.stage';
import { ExtractStage } from './extract.stage';
import { noopLog } from './pipeline-log';
import type { PipelineLog } from './pipeline-log';
import { ReconciliationService } from './reconcile.stage';
import type { ReconcileSummary } from './reconcile.stage';
import { enqueueSourceRepair } from '../reconcile-repair';
import { SOURCE_READERS } from './source-reader';
import type { SourceReader } from './source-reader';
import { VerifyStage } from './verify.stage';

/** The web-source fact budget: a fetched page is reference material — it
 * contributes salient facts, never the worst-case hundred. The value lives on
 * the source-type registry (`SOURCE_TYPES.web.factBudget`); this alias keeps
 * the number named where the pipeline documents it and the suite asserts it. */
export const WEB_MAX_FACTS: number = SOURCE_TYPES.web.factBudget;

/**
 * The job type connectors enqueue (via the outbox, in the capture transaction).
 * Idempotency key: (source_type, source_id, 'ingestion.pipeline') — spec §15.4.
 */
export const INGESTION_PIPELINE_JOB_TYPE = 'ingestion.pipeline';

/**
 * Deletes a discard-mode source's transient staging object (F1 handoff
 * §3). Enqueued by the pipeline in the SAME transaction as the derived
 * memories, so it fires only once they commit — the original is discarded only
 * after its extraction is durable. Idempotent (an absent object is success);
 * the handler lives in the worker task registry (deletes via the object store).
 */
export const FILE_DISCARD_CLEANUP_JOB_TYPE = 'file.discard_cleanup';

export interface PipelineSummary {
  sourceType: string;
  sourceId: string;
  chunks: number;
  extracted: number;
  verdicts: { supported: number; partial: number; unsupported: number };
  admitted: { active: number; uncertain: number };
  /**
   * Facts withheld before verification because storing them would be actively
   * wrong (V2.0 item 3.3): a blank claim or a blank span. Each one is in the
   * suppressed-fact log with its source and span, so a withheld fact is still
   * recoverable and explainable.
   */
  notAdmitted: number;
  embedded: number;
  reconcile: ReconcileSummary;
  /**
   * `source_missing`: the source vanished before the run started (stage 1).
   * `source_deleted`: the deletion saga erased the source DURING the run —
   * the admission checkpoint aborted before any row was written.
   * `gate_refused`: the extraction gate (V2.1 item 4.3, spec 1.6) refused the
   * source before any model call; the refusal ledger has the row that says so.
   */
  skipped?: 'source_missing' | 'source_deleted' | 'gate_refused';
}

/**
 * One worker job per source item, orchestrating the six pipeline stages
 * (glossary): ingest → chunk → extract → verify → embed + store → reconcile.
 * All six stages are real since.
 *
 * The whole run executes inside the job's idempotency transaction (`tx`), so
 * a retry after any failure — malformed model output, a failed Qdrant write —
 * leaves no partial rows behind (0005 for the
 * two-store ordering). Model calls hold the transaction open; acceptable at
 * worker concurrency 2 for note-sized sources, revisit for bulk connectors.
 */
@Injectable()
export class IngestionPipeline {
  constructor(
    @Inject(SOURCE_READERS) private readonly readers: SourceReader[],
    private readonly extractStage: ExtractStage,
    private readonly verifyStage: VerifyStage,
    private readonly embedStoreStage: EmbedStoreStage,
    private readonly reconciliationService: ReconciliationService,
    /** The record of every automatic non-admission (V2.0 item 3.3). */
    private readonly suppressedFacts: SuppressedFactLog,
    /** Parse/extraction caps; optional so bare/test builds still work. */
    @Optional() @Inject(PARSE_CAPS) private readonly parseCaps: ParseCaps = DEFAULT_PARSE_CAPS,
    /** Org resolution for audit stamping (V2.0 item 3.7). Appended LAST so no
     * existing wiring shifts; optional because bare harnesses have none, and
     * their entries then stay NULL-org, which is the safe direction. */
    @Optional() private readonly directory?: UserDirectory,
    /**
     * The per-source extraction gate (V2.1 item 4.3, spec 1.6). Optional so
     * bare harnesses (eval, old tests) run exactly as before: no gate service
     * means no admission control, which is also what an owner without gate
     * rows gets — today's behaviour, byte-identical.
     */
    @Optional() private readonly gate?: ExtractionGateStore,
    /**
     * The anchor stage (V2.1 item 4.2, spec 1.5). Optional so bare harnesses
     * run without it: no anchor means no document context, which is exactly
     * the pre-anchoring input, byte-identical.
     */
    @Optional() private readonly anchorStage?: AnchorStage,
    /**
     * The honest stage reporter (V2.2 item 5.1). Optional so bare harnesses
     * (eval, old tests) run exactly as before; when present, each stage the
     * run enters is upserted on the store's OWN connection, so a surface can
     * say "verifying" instead of a bare spinner. Never a way to fail the run.
     */
    @Optional() private readonly progress?: IngestionProgressStore,
    /**
     * The per-project extraction policy (V2.5 item 8.3 issue C4). Appended
     * LAST so no existing wiring shifts (the positional-optional hazard the
     * boundary contract names). NOT a new gate dimension: at most three
     * numbers folded into the same tightest-wins arithmetic, plus a disable
     * flag refused through the existing ledger. Absent, or a source in no
     * project, is the pre-feature path exactly.
     */
    @Optional() @Inject(PROJECT_POLICY) private readonly projectPolicy?: ProjectPolicyPort,
  ) {}

  async run(
    tx: Tx,
    payload: { source_type: string; source_id: string },
    log: PipelineLog = noopLog,
  ): Promise<PipelineSummary> {
    const summary: PipelineSummary = {
      sourceType: payload.source_type,
      sourceId: payload.source_id,
      chunks: 0,
      extracted: 0,
      verdicts: { supported: 0, partial: 0, unsupported: 0 },
      admitted: { active: 0, uncertain: 0 },
      notAdmitted: 0,
      embedded: 0,
      reconcile: {
        considered: 0,
        dedupChecks: 0,
        contradictionChecks: 0,
        ledgerHits: 0,
        deterministicChecks: 0,
        merged: 0,
        enriched: 0,
        contradictions: 0,
        reopened: 0,
        superseded: 0,
        resolvedByRevision: 0,
        actions: [],
      },
    };
    const ref = { source_type: payload.source_type, source_id: payload.source_id };

    // Run lock: announces this in-flight run to the
    // deletion saga's cancellation probe. idempotentTask already takes it for
    // worker deliveries; re-acquiring here (advisory xact locks are reentrant)
    // extends the guarantee to every direct pipeline.run caller (tests, eval).
    await acquireJobRunLock(tx, {
      sourceType: payload.source_type,
      sourceId: payload.source_id,
      jobType: INGESTION_PIPELINE_JOB_TYPE,
    });

    // Stage 1 — ingest: load the source through its connector's reader port.
    const reader = this.readers.find((r) => r.sourceType === payload.source_type);
    if (!reader) {
      throw new Error(`no source reader registered for source_type '${payload.source_type}'`);
    }
    const stageRef = { sourceType: payload.source_type, sourceId: payload.source_id };
    await this.progress?.report(stageRef, 'reading');
    const source = await reader.load(payload.source_id);
    if (!source) {
      // The source vanished before processing (e.g. deleted). Complete cleanly.
      summary.skipped = 'source_missing';
      log({ stage: 'ingest', ...ref, skipped: true }, 'source missing; nothing to do');
      return summary;
    }

    // Stage 1.5 — the extraction gate (V2.1 item 4.3, spec 1.6): the analogue
    // of the first-person rule, one stage earlier. A cheap deterministic table
    // read decides admission BEFORE any model call, so a disabled connector or
    // a denied document class costs nothing and floods nothing. The decision
    // needs the owner and the reader-stamped document class, which is why it
    // sits after load rather than before it; a refused source is recorded in
    // the metadata-only refusal ledger so it never looks processed-with-zero-
    // facts. The source itself stays stored — the gate controls extraction,
    // never capture.
    let gateBudget: number | null = null;
    let gateRetentionDays: number | null = null;
    if (this.gate) {
      const decision = await this.gate.decisionFor(tx, {
        ownerId: source.ownerId,
        // The gate that admits a source is the one configured in the space
        // the source lives in (the settings split, migration 0062).
        spaceId: source.spaceId,
        sourceType: payload.source_type,
        sourceId: payload.source_id,
        documentClass: source.documentClass,
        folder: source.gateFolder,
      });
      if (!decision.allowed) {
        summary.skipped = 'gate_refused';
        await this.gate.recordRefusal(tx, {
          ownerId: source.ownerId,
          spaceId: source.spaceId,
          sourceType: payload.source_type,
          sourceId: payload.source_id,
          reason: decision.reason,
          documentClass: decision.documentClass,
        });
        log(
          { stage: 'gate', ...ref, reason: decision.reason },
          'extraction refused by the gate; recorded in the refusal ledger',
        );
        return summary;
      }
      gateBudget = decision.factBudget;
      gateRetentionDays = decision.retentionDays;
    }

    // Stage 1.5b — the project's own extraction policy (V2.5 item 8.3 issue
    // C4), applied at the SAME chokepoint and folded into the SAME
    // arithmetic. A project is not a settings hierarchy: three numbers, and
    // a disable that refuses through the existing metadata-only ledger with
    // its own named reason, so a project-gated source never looks
    // processed-with-zero-facts either.
    if (this.projectPolicy) {
      const policy = await this.projectPolicy
        .policyForSource(payload.source_type, payload.source_id)
        .catch(() => null);
      if (policy?.enabled === false) {
        summary.skipped = 'gate_refused';
        await this.gate?.recordRefusal(tx, {
          ownerId: source.ownerId,
          spaceId: source.spaceId,
          sourceType: payload.source_type,
          sourceId: payload.source_id,
          reason: 'project_disabled',
          documentClass: source.documentClass ?? undefined,
        });
        log(
          { stage: 'gate', ...ref, reason: 'project_disabled' },
          'extraction refused by the project policy; recorded in the refusal ledger',
        );
        return summary;
      }
      if (policy) {
        gateBudget = tightest(gateBudget, policy.factBudget);
        gateRetentionDays = tightest(gateRetentionDays, policy.retentionDays);
      }
    }

    // Stage 1.6 — anchor (V2.1 item 4.2, spec 1.5): one cheap call over the
    // document's opening and filename produces the source context, stored on
    // the source and injected into every chunk's extraction call below. A
    // user-edited context is reused verbatim; a failed call degrades to no
    // context (anchoring only reduces ambiguity, never blocks).
    const sourceContext = this.anchorStage ? await this.anchorStage.run(tx, source, log) : null;
    if (sourceContext) {
      log(
        {
          stage: 'anchor',
          ...ref,
          subjects: sourceContext.subjects.length,
          hasClass: sourceContext.documentClass !== null,
        },
        'source context anchored',
      );
    }

    // Stage 2 — chunk: transient values, never rows. Parse caps bound
    // the work a single source can drive: text length (defense in depth over
    // the file extractor's own cap, covering every source type) and chunk count
    // (which bounds the per-chunk extraction model calls). Over-cap input is
    // truncated with a log rather than failed — a legitimate long source still
    // yields its leading facts.
    const content =
      source.content.length > this.parseCaps.maxTextChars
        ? source.content.slice(0, this.parseCaps.maxTextChars)
        : source.content;
    if (content.length < source.content.length) {
      log(
        { stage: 'chunk', ...ref, cappedTextChars: this.parseCaps.maxTextChars },
        'source text capped',
      );
    }
    let chunks = chunkContent(content);
    if (chunks.length > this.parseCaps.maxChunks) {
      log({ stage: 'chunk', ...ref, cappedChunks: this.parseCaps.maxChunks }, 'chunk count capped');
      chunks = chunks.slice(0, this.parseCaps.maxChunks);
    }
    summary.chunks = chunks.length;

    await this.progress?.report(stageRef, 'extracting');
    // Stage 3 — extract: empty content short-circuits with zero model calls;
    // a durable-fact-free source legitimately yields [] (calibrated abstention).
    // The facts array is capped so a pathological source cannot fan out
    // into thousands of verify/reconcile/embed calls and memory rows.
    let facts = await this.extractStage.run(source, chunks, sourceContext);
    // Reference-material types carry a tighter fact budget in the source-type
    // registry (web: salient facts, not a hundred rows of page noise — the cap
    // also bounds the verify/reconcile/embed fan-out that made big pages
    // slow). First-person sources have no budget and keep the full cap.
    // The gate's own budget (V2.1 item 4.3) joins the min: the tightest of the
    // parse cap, the registry budget and the owner's configured budget wins.
    const factBudget = sourceTypeDescriptor(payload.source_type)?.factBudget ?? null;
    const maxFacts = Math.min(
      ...[this.parseCaps.maxFacts, factBudget, gateBudget].filter(
        (cap): cap is number => cap !== null,
      ),
    );
    if (facts.length > maxFacts) {
      log({ stage: 'extract', ...ref, cappedFacts: maxFacts }, 'fact count capped');
      facts = facts.slice(0, maxFacts);
    }
    summary.extracted = facts.length;

    // Admission line, before any model spend (V2.0 item 3.3). The ONE case
    // where a fact is not stored at all: a blank claim (a memory row with no
    // content) or a blank span (a fact with no provenance to inspect). Storing
    // either would be actively wrong rather than merely uncertain, so they are
    // withheld — and logged with their source and span, so a withheld fact is
    // still recoverable and explainable. Everything else is admitted.
    const invalid = facts.filter((fact) => !structurallyValid(fact));
    if (invalid.length > 0) {
      facts = facts.filter((fact) => structurallyValid(fact));
      summary.notAdmitted = invalid.length;
      log(
        { stage: 'extract', ...ref, notAdmitted: invalid.length },
        'structurally invalid facts withheld',
      );
    }

    // Stage 4 — verify: the independent spec §2 pass decides each fact's verdict.
    await this.progress?.report(stageRef, 'verifying');
    const verified = await this.verifyStage.run(chunks, facts);
    for (const { verdict } of verified) summary.verdicts[verdict] += 1;
    log(
      { stage: 'verify', ...ref, extracted: summary.extracted, ...summary.verdicts },
      'verification pass complete',
    );

    // Admission checkpoint: the source may have been
    // deleted by the saga while the model stages above held this transaction
    // open. Re-verify — with a KEY SHARE row lock, in THIS transaction — that
    // the durable source row still exists before writing anything. If the
    // saga's FOR UPDATE + DELETE already committed, abort cleanly: no rows, no
    // points, the job completes as a no-op (consuming its idempotency key) and
    // leaves an audit trace. If the check wins the lock instead, it is held to
    // commit, so a concurrent saga enumerates AFTER our memories are visible
    // and erases them under its receipt. Discard-mode file sources have no
    // durable row by design (stagingKey set) — they are protected by the
    // saga's idempotency-key cancellation, which waits out in-flight runs.
    // Withheld facts count as "something to write": their log entries carry
    // source content and a span, so they are guarded by the same checkpoint the
    // memory rows are.
    if ((verified.length > 0 || invalid.length > 0) && !source.stagingKey) {
      const sourceStillExists = await reader.existsForAdmission(tx, payload.source_id);
      if (!sourceStillExists) {
        summary.skipped = 'source_deleted';
        await writeAudit(tx, {
          actor: 'ingestion_pipeline',
          action: 'ingestion.admission_aborted',
          entityType: 'source',
          entityId: `${payload.source_type}/${payload.source_id}`,
          detail: { ...ref, verified: verified.length, cause: 'source_deleted_mid_flight' },
          // The owner's org from the directory (V2.0 item 3.7): the pipeline
          // runs in the worker with no Principal, and a NULL-org entry is
          // readable from every org.
          orgId: (await this.directory?.orgOf(source.ownerId)) ?? undefined,
          ownerId: source.ownerId,
          spaceId: source.spaceId,
        });
        log({ stage: 'admission', ...ref, skipped: true }, 'source deleted mid-flight; aborting');
        return summary;
      }
    }

    // The non-admitted half of the log, written past the checkpoint so it
    // shares the memory rows' all-or-nothing guarantee. `memoryId` is null:
    // that null IS the record that the fact was withheld rather than demoted.
    if (invalid.length > 0) {
      const entries: SuppressedFactEntry[] = invalid.map((fact) => ({
        ownerId: source.ownerId,
        scope: source.scope ?? 'private',
        sensitive: source.sensitive ?? false,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        factContent: fact.claim,
        factKind: fact.kind,
        sourceSpan: fact.source_span,
        // A structurally invalid fact usually has a BLANK span, so this is
        // almost always null; located when the span exists (V2.2 item 5.2).
        spanLocators:
          source.segments && fact.source_span
            ? locatedOrNull(source.content, source.segments, fact.source_span)
            : null,
        reason: 'structurally_invalid',
        // No verification ran: a fact this malformed never reaches the verifier,
        // and inventing a verdict for it would be inventing evidence.
        verificationVerdict: null,
        verificationReason: null,
        promptVersion: null,
        memoryId: null,
      }));
      await this.suppressedFacts.record(tx, entries);
    }

    // Stage 5 — embed + store: batched embedding, Postgres rows (status per
    // verdict), Qdrant points last. Gate retention (V2.1 item 4.3) rides along:
    // it bounds only facts with no extractor-resolved validity of their own.
    await this.progress?.report(stageRef, 'storing');
    const admitted = await this.embedStoreStage.run(tx, source, verified, {
      retentionDays: gateRetentionDays,
    });
    for (const { status } of admitted) summary.admitted[status] += 1;
    summary.embedded = admitted.length;
    log(
      { stage: 'embed_store', ...ref, embedded: summary.embedded, ...summary.admitted },
      'facts embedded and stored',
    );

    // Stage 6 — reconcile: new facts vs the owner's existing
    // memory, inside the same idempotency transaction as their admission.
    summary.reconcile = await this.reconciliationService.reconcile(
      tx,
      admitted.map(({ row, embedding }) => ({ row, embedding })),
      log,
      { exclude: 'same_batch', detectedBy: 'pipeline' },
    );
    const { actions, ...reconcileCounts } = summary.reconcile;
    log(
      { stage: 'reconcile', ...ref, ...reconcileCounts, actionCount: actions.length },
      'reconciliation complete',
    );

    // Repair window (V2.3 item 6.1, issue B): facts admitted by CONCURRENT
    // jobs are invisible to this transaction, so near-simultaneous uploads
    // never pair inline. One delayed repair per source re-pairs against
    // whatever committed meanwhile; the checked-pair ledger keeps the re-run
    // free of duplicate model spend. Enqueued in THIS transaction, so it
    // fires only if the admission commits.
    if (admitted.length > 0) {
      await enqueueSourceRepair(tx, source.sourceType, source.sourceId);
      log({ stage: 'reconcile', ...ref }, 'repair window enqueued');
    }

    // Extract-and-discard (F1 handoff §3): schedule the staging object's
    // deletion in THIS transaction — it fires only when the derived memories
    // commit, so the original is discarded only after extraction is durable.
    if (source.stagingKey) {
      await withTransactionalEnqueue(
        tx,
        { type: 'source.discard_original', payload: ref },
        {
          type: FILE_DISCARD_CLEANUP_JOB_TYPE,
          payload: { source_type: source.sourceType, source_id: source.stagingKey },
        },
      );
      log({ stage: 'discard_cleanup_enqueue', ...ref }, 'discard staging cleanup enqueued');
    }
    return summary;
  }
}

/** A span's locators for the suppressed log, or null when none resolve. */
function locatedOrNull(
  content: string,
  segments: readonly ReadSegment[],
  span: string,
): ReadLocator[] | null {
  const found = locateSpan(content, segments, span);
  return found.length > 0 ? found : null;
}

export interface CreatePipelineOptions {
  readers: SourceReader[];
  gateway: ModelGateway;
  store: MemoryStore;
  reconciliation: MemoryReconciliation;
  /** The suppressed-fact log every admission decision writes to. */
  suppressedFacts: SuppressedFactLog;
  /** Parse/extraction caps; the generous defaults apply when omitted. */
  parseCaps?: ParseCaps;
  /** The extraction gate (V2.1 item 4.3); omitted = no admission control,
   * exactly what an owner without gate rows gets. */
  gate?: ExtractionGateStore;
  /** The anchor stage (V2.1 item 4.2); omitted = no document context. */
  anchor?: AnchorStage;
  /** The honest stage reporter (V2.2 item 5.1); omitted = no stage rows. */
  progress?: IngestionProgressStore;
}

/**
 * Composition helper for non-Nest callers (integration tests, eval): assembles
 * the pipeline from its stages so the stage classes can stay module-private
 * (the Nest composition root wires them via DI). Mirrors memory's
 * createMemoryStore — primitives in, one object out.
 */
export function createIngestionPipeline(options: CreatePipelineOptions): IngestionPipeline {
  return new IngestionPipeline(
    options.readers,
    new ExtractStage(options.gateway),
    new VerifyStage(options.gateway),
    new EmbedStoreStage(options.gateway, options.store, options.suppressedFacts),
    new ReconciliationService(options.gateway, options.store, options.reconciliation),
    options.suppressedFacts,
    options.parseCaps ?? DEFAULT_PARSE_CAPS,
    undefined,
    options.gate,
    options.anchor,
    options.progress,
  );
}

/** The tightest of two optional bounds; null means "no bound from here". */
function tightest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
