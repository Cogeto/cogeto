import { Inject, Injectable } from '@nestjs/common';
import {
  acquireJobRunLock,
  withTransactionalEnqueue,
  writeAudit,
} from '../../infrastructure/index';
import type { Tx } from '../../infrastructure/index';
import type { MemoryReconciliation, MemoryStore } from '../../memory/index';
import type { ModelGateway } from '../../model-gateway/index';
import { chunkContent } from './chunk';
import { EmbedStoreStage } from './embed-store.stage';
import { ExtractStage } from './extract.stage';
import { noopLog } from './pipeline-log';
import type { PipelineLog } from './pipeline-log';
import { ReconciliationService } from './reconcile.stage';
import type { ReconcileSummary } from './reconcile.stage';
import { SOURCE_READERS } from './source-reader';
import type { SourceReader } from './source-reader';
import { VerifyStage } from './verify.stage';

/**
 * The job type connectors enqueue (via the outbox, in the capture transaction).
 * Idempotency key: (source_type, source_id, 'ingestion.pipeline') — §A.3.
 */
export const INGESTION_PIPELINE_JOB_TYPE = 'ingestion.pipeline';

/**
 * Deletes a discard-mode source's transient staging object (§A.9, F1 handoff
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
  embedded: number;
  reconcile: ReconcileSummary;
  /**
   * `source_missing`: the source vanished before the run started (stage 1).
   * `source_deleted`: the deletion saga erased the source DURING the run —
   * the admission checkpoint aborted before any row was written (QS-5).
   */
  skipped?: 'source_missing' | 'source_deleted';
}

/**
 * One worker job per source item, orchestrating the six pipeline stages
 * (glossary): ingest → chunk → extract → verify → embed + store → reconcile.
 * All six stages are real since F2-A (decision 0010).
 *
 * The whole run executes inside the job's idempotency transaction (`tx`), so
 * a retry after any failure — malformed model output, a failed Qdrant write —
 * leaves no partial rows behind (decision 0004 ruling 3; 0005 for the
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
      embedded: 0,
      reconcile: {
        considered: 0,
        dedupChecks: 0,
        contradictionChecks: 0,
        merged: 0,
        enriched: 0,
        contradictions: 0,
        superseded: 0,
        actions: [],
      },
    };
    const ref = { source_type: payload.source_type, source_id: payload.source_id };

    // Run lock (QS-5, decision 0024): announces this in-flight run to the
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
    const source = await reader.load(payload.source_id);
    if (!source) {
      // The source vanished before processing (e.g. deleted). Complete cleanly.
      summary.skipped = 'source_missing';
      log({ stage: 'ingest', ...ref, skipped: true }, 'source missing; nothing to do');
      return summary;
    }

    // Stage 2 — chunk: transient values, never rows.
    const chunks = chunkContent(source.content);
    summary.chunks = chunks.length;

    // Stage 3 — extract: empty content short-circuits with zero model calls;
    // a durable-fact-free source legitimately yields [] (calibrated abstention).
    const facts = await this.extractStage.run(source, chunks);
    summary.extracted = facts.length;

    // Stage 4 — verify: the independent §B.3 pass decides each fact's verdict.
    const verified = await this.verifyStage.run(chunks, facts);
    for (const { verdict } of verified) summary.verdicts[verdict] += 1;
    log(
      { stage: 'verify', ...ref, extracted: summary.extracted, ...summary.verdicts },
      'verification pass complete',
    );

    // Admission checkpoint (QS-5, decision 0024): the source may have been
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
    if (verified.length > 0 && !source.stagingKey) {
      const sourceStillExists = await reader.existsForAdmission(tx, payload.source_id);
      if (!sourceStillExists) {
        summary.skipped = 'source_deleted';
        await writeAudit(tx, {
          actor: 'ingestion_pipeline',
          action: 'ingestion.admission_aborted',
          entityType: 'source',
          entityId: `${payload.source_type}/${payload.source_id}`,
          detail: { ...ref, verified: verified.length, reason: 'source_deleted_mid_flight' },
        });
        log({ stage: 'admission', ...ref, skipped: true }, 'source deleted mid-flight; aborting');
        return summary;
      }
    }

    // Stage 5 — embed + store: batched embedding, Postgres rows (status per
    // verdict), Qdrant points last.
    const admitted = await this.embedStoreStage.run(tx, source, verified);
    for (const { status } of admitted) summary.admitted[status] += 1;
    summary.embedded = admitted.length;
    log(
      { stage: 'embed_store', ...ref, embedded: summary.embedded, ...summary.admitted },
      'facts embedded and stored',
    );

    // Stage 6 — reconcile (decision 0010): new facts vs the owner's existing
    // memory, inside the same idempotency transaction as their admission.
    summary.reconcile = await this.reconciliationService.reconcile(
      tx,
      admitted.map(({ row, embedding }) => ({ row, embedding })),
      log,
    );
    const { actions, ...reconcileCounts } = summary.reconcile;
    log(
      { stage: 'reconcile', ...ref, ...reconcileCounts, actionCount: actions.length },
      'reconciliation complete',
    );

    // Task derivation (decision 0013 ruling 2): a cross-module EVENT, in the
    // same transaction as admission — the tasks engine derives and judges in
    // its own idempotent job. Nothing admitted → nothing to derive or judge.
    if (admitted.length > 0) {
      await withTransactionalEnqueue(
        tx,
        { type: 'source.processed', payload: ref },
        { type: 'tasks.derive', payload: ref },
      );
      log({ stage: 'tasks_enqueue', ...ref }, 'task derivation enqueued');
    }

    // Extract-and-discard (§A.9, F1 handoff §3): schedule the staging object's
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

export interface CreatePipelineOptions {
  readers: SourceReader[];
  gateway: ModelGateway;
  store: MemoryStore;
  reconciliation: MemoryReconciliation;
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
    new EmbedStoreStage(options.gateway, options.store),
    new ReconciliationService(options.gateway, options.store, options.reconciliation),
  );
}
