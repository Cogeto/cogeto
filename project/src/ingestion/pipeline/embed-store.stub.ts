import type { PipelineLog } from './pipeline-log';

export interface AdmittedMemory {
  memoryId: string;
  status: 'active' | 'uncertain';
}

/**
 * Stage 5 (embed + store) — stub. Admitted facts are already persisted rows
 * (admission commits with the verify verdict, stage 4); what this stage adds
 * in S2-B is the embedding half: batch-embed each admitted fact via the
 * gateway, upsert the Qdrant point with payload copies of the gates (§A.4),
 * and set content_embedding_ref. Until then it logs and passes through.
 */
export function embedAndStoreStub(admitted: AdmittedMemory[], log: PipelineLog): AdmittedMemory[] {
  log(
    { stage: 'embed_store', admitted: admitted.length, implemented: false },
    'embed + store stub: embedding and Qdrant upsert arrive in S2-B',
  );
  return admitted;
}
