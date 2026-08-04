/** Public interface of the ingestion bounded context (spec §15 rule 1). */
export { IngestionModule, SuppressedFactCascadeModule } from './ingestion.module';
export {
  IngestionPipeline,
  INGESTION_PIPELINE_JOB_TYPE,
  FILE_DISCARD_CLEANUP_JOB_TYPE,
  createIngestionPipeline,
} from './pipeline/pipeline.service';
// The suppressed-fact log (V2.0 item 3.3): the record of every automatic
// demotion or non-admission, its gated query surface, and its deletion-cascade
// adapter (memory owns the DerivedCascade port; ingestion owns the table).
export { createSuppressedFactLog } from './persistence/suppressed-fact-log';
export { SuppressedFactCascade } from './suppressed-fact-cascade';
// The per-source extraction gate (V2.1 item 4.3, spec 1.6): admission control
// enforced by the pipeline, its refusal ledger's retention job, and the
// cascade that removes refusal rows with their source.
export {
  ExtractionGateStore,
  createExtractionGateStore,
  EXTRACTION_REFUSAL_RETENTION_DAYS,
  EXTRACTION_REFUSAL_RETENTION_JOB_TYPE,
  EXTRACTION_REFUSAL_RETENTION_CRONTAB,
} from './persistence/extraction-gate.store';
export {
  ExtractionRefusalCascade,
  ExtractionRefusalCascadeModule,
} from './extraction-refusal-cascade';
// The source context (V2.1 item 4.2, spec 1.5): the anchor call's stored
// result, its cascade, and the storage-free anchor computation the eval
// harness runs the real chain with.
export { SourceContextStore, createSourceContextStore } from './persistence/source-context.store';
export type { SourceContextValue } from './persistence/source-context.store';
export { SourceContextCascade, SourceContextCascadeModule } from './source-context-cascade';
export { AnchorStage, computeSourceContext, ANCHOR_OPENING_CHARS } from './pipeline/anchor.stage';
// The admission taxonomy: the pure mapping every outcome passes through.
export { SOURCE_READERS } from './pipeline/source-reader';
export type { SourceReader, SourceItem } from './pipeline/source-reader';
// The shared chunker: connectors' capture-time relevance
// pre-pass splits pages with the SAME boundaries extraction will use.
export { chunkContent } from './pipeline/chunk';
// The deletion saga's pending-ingestion cancellation —
// memory defines the IngestionGuard port; this module implements it because it
// owns the pipeline job type. Composition roots bind it into MemoryModule.
export { PipelineIngestionGuard } from './pipeline/pipeline-guard';
export type { PipelineLog } from './pipeline/pipeline-log';
export { DreamingService, DREAM_JOB_TYPE, DREAM_CRONTAB, dreamRunStatus } from './dreaming.service';
export type { DreamRunStatus } from './dreaming.service';
// The digest endpoint. Since the digest has exactly one section
// (the nightly consolidation) — the tasks section went with the subsystem.
// The digest builder — reused by the attention feed so
// there is one digest, gated once — plus the dreaming activity series.
export { buildDreamDigest, dreamingActivityForPrincipal } from './dream-digest';
export { ReconciliationService } from './pipeline/reconcile.stage';
export { ACTIVE_PROMPTS, ANCHORING_PROMPT, VISION_READ_PROMPT } from './prompt-versions';
export { runGoldenEval, evalConfigSchema } from './eval-harness';
export type { EvalMetrics } from './eval-harness';
export { runReconcileEval } from './eval-reconcile';
export type { ReconcileEvalMetrics } from './eval-reconcile';
export { seedMemoryFromSource } from './eval-seed';
// The dormant-flag consumption API (F2 handoff §3): the read-and-clear window
// into ingestion's dormant_flag table. Retrieval's open-loops read consumes it
// to mark an obligation "gone quiet"; never a write.
export { listOpenDormantFlags } from './dormant-flags';
// The S3.5 deterministic date resolver — reused by
// temporal query understanding; never duplicated.
export { resolveExpression } from './domain/temporal-resolver';
// Thread-aware email extraction pre-processing
// isolate the new content of an email body (unwrap forwarded, drop quoted
// history + signature) before extraction. Shared by the email SourceReader and
// the golden-set harness so both isolate identically.
export {
  isolateEmailContent,
  isolateEmailContentDetailed,
  parseForwardedHeaders,
} from './pipeline/email-preprocess';
