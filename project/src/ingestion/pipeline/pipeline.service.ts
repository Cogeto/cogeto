import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '../../infrastructure/index';
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

export interface PipelineSummary {
  sourceType: string;
  sourceId: string;
  chunks: number;
  extracted: number;
  verdicts: { supported: number; partial: number; unsupported: number };
  admitted: { active: number; uncertain: number };
  embedded: number;
  reconcile: ReconcileSummary;
  skipped?: 'source_missing';
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
      },
    };
    const ref = { source_type: payload.source_type, source_id: payload.source_id };

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
    log({ stage: 'reconcile', ...ref, ...summary.reconcile }, 'reconciliation complete');
    return summary;
  }
}
