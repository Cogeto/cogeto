import { Inject, Injectable, Optional } from '@nestjs/common';
import { DEFAULT_INSTANCE_TIMEZONE, INSTANCE_TIMEZONE } from '../../infrastructure/index';
import type { Tx } from '../../infrastructure/index';
import { MemoryStore } from '../../memory/index';
import type { MemoryRow } from '../../memory/index';
import { ModelGateway } from '../../model-gateway/index';
import { resolveFactTemporal } from '../domain/candidate-fact';
import { verificationResult } from '../persistence/tables';
import type { SourceItem } from './source-reader';
import type { VerifiedFact } from './verify.stage';

export interface AdmittedMemory {
  memoryId: string;
  status: 'active' | 'uncertain';
  /** The committed-in-tx row and its stage-5 embedding — stage 6's input. */
  row: MemoryRow;
  embedding: number[];
}

/**
 * Stage 5 (embed + store), real from S2-B: each verified fact is embedded and
 * persisted in the same step (glossary; supersedes 0004 ruling 1's stage-4
 * admission — see decision 0005). Order inside the job's idempotency
 * transaction:
 *
 *   1. one batched embed call for all claims (model work before any write);
 *   2. Postgres rows — memory (status per the §B.3 verdict, embedding_model
 *      recorded) + verification_result, inside `tx`;
 *   3. Qdrant points LAST, id = memory id.
 *
 * Two-store safety: a failed point write throws → `tx` rolls back the rows and
 * the job retries — never a duplicate row. Points written before the failure
 * can survive as orphans (ids that no longer exist in Postgres); they are
 * invisible to reads (hits are resolved through gated Postgres reads) and are
 * swept by reindex / the §A.7 nightly job. Postgres stays the source of truth.
 */
@Injectable()
export class EmbedStoreStage {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly memoryStore: MemoryStore,
    // The instance timezone for relative-date resolution (QS-32); @Optional so
    // bare/test builds fall back to the default without wiring LimitsModule.
    @Optional()
    @Inject(INSTANCE_TIMEZONE)
    private readonly timeZone: string = DEFAULT_INSTANCE_TIMEZONE,
  ) {}

  async run(tx: Tx, source: SourceItem, verified: VerifiedFact[]): Promise<AdmittedMemory[]> {
    if (verified.length === 0) return [];

    const embeddings = await this.gateway.embed(verified.map((v) => v.fact.claim));
    const embeddingModel = this.gateway.embeddingModelId();

    const rows: MemoryRow[] = [];
    const admitted: AdmittedMemory[] = [];
    for (const [i, { fact, verdict, reason, promptVersion }] of verified.entries()) {
      // Admission rule (S3.5-B, F7): active ONLY when the source stated it
      // plainly (hedged=false) AND the verifier supported it; a hedged fact is
      // uncertain even when supported, because the SOURCE was tentative.
      const status = !fact.hedged && verdict === 'supported' ? 'active' : 'uncertain';
      // Dates are resolved by code against the note anchor (decision 0007
      // ruling 1); v0001 still passes through its pre-resolved fields.
      const { validFrom, validUntil, unresolved } = resolveFactTemporal(
        fact,
        source.createdAt,
        this.timeZone,
      );
      const row = await this.memoryStore.admitExtractedFact(tx, source.ownerId, {
        content: fact.claim,
        // Notes are private in v1 (S2-A §4); file uploads inherit the upload's
        // scope selector and sensitive checkbox (F1 handoff). The source item
        // carries both — absent means the note default.
        scope: source.scope ?? 'private',
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        entities: flattenEntities(fact),
        subjectEntity: fact.subject_entity ?? undefined,
        kind: fact.kind,
        sensitive: source.sensitive ?? false,
        validFrom,
        validUntil,
        temporalUnresolved: unresolved,
        initialStatus: status,
        embeddingModel,
      });
      await tx.insert(verificationResult).values({
        memoryId: row.id,
        verdict,
        reason,
        promptVersion,
        sourceSpan: fact.source_span,
        hedgePhrase: fact.hedged ? fact.hedge_phrase : null,
      });
      rows.push(row);
      admitted.push({ memoryId: row.id, status, row, embedding: embeddings[i]! });
    }

    await this.memoryStore.upsertVectors(rows, embeddings);
    return admitted;
  }
}

/**
 * The memory row stores entities flat (decision 0006 ruling 2): people,
 * organizations and projects in one deduplicated array, names exactly as the
 * extractor preserved them from the source.
 */
export function flattenEntities(fact: VerifiedFact['fact']): string[] {
  const flat = [...fact.entities.people, ...fact.entities.organizations, ...fact.entities.projects]
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return [...new Set(flat)];
}
