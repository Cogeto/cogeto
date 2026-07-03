import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '../../infrastructure/index';
import { MemoryStore } from '../../memory/index';
import { resolveTemporal } from '../domain/candidate-fact';
import { verificationResult } from '../persistence/tables';
import { chunkContent } from './chunk';
import type { AdmittedMemory } from './embed-store.stub';
import { embedAndStoreStub } from './embed-store.stub';
import { ExtractStage } from './extract.stage';
import { noopLog } from './pipeline-log';
import type { PipelineLog } from './pipeline-log';
import { reconcileStub } from './reconcile.stub';
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
  skipped?: 'source_missing';
}

/**
 * One worker job per source item, orchestrating the six pipeline stages
 * (glossary): ingest → chunk → extract → verify → embed + store → reconcile.
 * S2-A implements stages 1–4; 5 and 6 are logging stubs (S2-B / Session 4).
 *
 * The whole run executes inside the job's idempotency transaction (`tx`), so
 * a retry after any failure — including malformed model output — leaves no
 * partial memories behind. Model calls hold the transaction open; acceptable
 * at worker concurrency 2 for note-sized sources, revisit for bulk connectors.
 */
@Injectable()
export class IngestionPipeline {
  constructor(
    @Inject(SOURCE_READERS) private readonly readers: SourceReader[],
    private readonly extractStage: ExtractStage,
    private readonly verifyStage: VerifyStage,
    private readonly memoryStore: MemoryStore,
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
    };

    // Stage 1 — ingest: load the source through its connector's reader port.
    const reader = this.readers.find((r) => r.sourceType === payload.source_type);
    if (!reader) {
      throw new Error(`no source reader registered for source_type '${payload.source_type}'`);
    }
    const source = await reader.load(payload.source_id);
    if (!source) {
      // The source vanished before processing (e.g. deleted). Complete cleanly.
      summary.skipped = 'source_missing';
      log({ stage: 'ingest', ...refOf(summary), skipped: true }, 'source missing; nothing to do');
      return summary;
    }

    // Stage 2 — chunk: transient values, never rows.
    const chunks = chunkContent(source.content);
    summary.chunks = chunks.length;

    // Stage 3 — extract: empty content short-circuits with zero model calls;
    // a durable-fact-free source legitimately yields [] (calibrated abstention).
    const facts = await this.extractStage.run(source, chunks);
    summary.extracted = facts.length;

    // Stage 4 — verify, then admit per the §B.3 rule: supported → active,
    // partial/unsupported → uncertain, verdict + reason stored alongside.
    const verified = await this.verifyStage.run(chunks, facts);
    const admitted: AdmittedMemory[] = [];
    for (const { fact, verdict, reason, promptVersion } of verified) {
      summary.verdicts[verdict] += 1;
      const status = verdict === 'supported' ? 'active' : 'uncertain';
      const row = await this.memoryStore.admitExtractedFact(tx, source.ownerId, {
        content: fact.claim,
        scope: 'private', // notes are private in v1 (S2-A §4)
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sensitive: false,
        ...resolveTemporal(fact.temporal),
        initialStatus: status,
      });
      await tx.insert(verificationResult).values({
        memoryId: row.id,
        verdict,
        reason,
        promptVersion,
      });
      summary.admitted[status] += 1;
      admitted.push({ memoryId: row.id, status });
      // fact.entities are not persisted yet: entity storage lands with the
      // retrieval work (trigram entity match) — recorded in docs/sessions/S2-A.md.
    }
    log(
      { stage: 'verify', ...refOf(summary), extracted: summary.extracted, ...summary.verdicts },
      'verification pass complete',
    );

    // Stage 5 — embed + store (stub: S2-B). Stage 6 — reconcile (stub: Session 4).
    reconcileStub(embedAndStoreStub(admitted, log), log);
    return summary;
  }
}

function refOf(summary: PipelineSummary): Record<string, unknown> {
  return { source_type: summary.sourceType, source_id: summary.sourceId };
}
