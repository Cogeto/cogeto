import { Injectable } from '@nestjs/common';
import type { Tx } from '../../infrastructure/index';
import { MemoryStore } from '../../memory/index';
import type { MemoryRow } from '../../memory/index';
import { ModelGateway } from '../../model-gateway/index';
import { resolveTemporal } from '../domain/candidate-fact';
import { verificationResult } from '../persistence/tables';
import type { SourceItem } from './source-reader';
import type { VerifiedFact } from './verify.stage';

export interface AdmittedMemory {
  memoryId: string;
  status: 'active' | 'uncertain';
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
  ) {}

  async run(tx: Tx, source: SourceItem, verified: VerifiedFact[]): Promise<AdmittedMemory[]> {
    if (verified.length === 0) return [];

    const embeddings = await this.gateway.embed(verified.map((v) => v.fact.claim));
    const embeddingModel = this.gateway.embeddingModelId();

    const rows: MemoryRow[] = [];
    const admitted: AdmittedMemory[] = [];
    for (const { fact, verdict, reason, promptVersion } of verified) {
      const status = verdict === 'supported' ? 'active' : 'uncertain';
      const row = await this.memoryStore.admitExtractedFact(tx, source.ownerId, {
        content: fact.claim,
        scope: 'private', // notes are private in v1 (S2-A §4)
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        entities: flattenEntities(fact),
        sensitive: false,
        ...resolveTemporal(fact.temporal),
        initialStatus: status,
        embeddingModel,
      });
      await tx.insert(verificationResult).values({
        memoryId: row.id,
        verdict,
        reason,
        promptVersion,
      });
      rows.push(row);
      admitted.push({ memoryId: row.id, status });
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
