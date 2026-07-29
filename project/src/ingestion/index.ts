/** Public interface of the ingestion bounded context (spec §15 rule 1). */
export { IngestionModule } from './ingestion.module';
export type { IngestionModuleOptions } from './ingestion.module';
export {
  IngestionPipeline,
  INGESTION_PIPELINE_JOB_TYPE,
  FILE_DISCARD_CLEANUP_JOB_TYPE,
  createIngestionPipeline,
} from './pipeline/pipeline.service';
export type { PipelineSummary, CreatePipelineOptions } from './pipeline/pipeline.service';
export { SOURCE_READERS } from './pipeline/source-reader';
export type { SourceReader, SourceItem } from './pipeline/source-reader';
// The shared chunker: connectors' capture-time relevance
// pre-pass splits pages with the SAME boundaries extraction will use.
export { chunkContent, CHUNK_MAX_CHARS } from './pipeline/chunk';
// The deletion saga's pending-ingestion cancellation —
// memory defines the IngestionGuard port; this module implements it because it
// owns the pipeline job type. Composition roots bind it into MemoryModule.
export { PipelineIngestionGuard } from './pipeline/pipeline-guard';
export type { PipelineLog } from './pipeline/pipeline-log';
export { DreamingService, DREAM_JOB_TYPE, DREAM_CRONTAB, dreamRunStatus } from './dreaming.service';
export type { DreamReport, DreamRunStatus } from './dreaming.service';
// The digest endpoint. Since the digest has exactly one section
// (the nightly consolidation) — the tasks section went with the subsystem.
export { DreamingController } from './dreaming.controller';
// The digest builder — reused by the attention feed so
// there is one digest, gated once — plus the dreaming activity series.
export { buildDreamDigest, buildDigestLines, dreamingActivityForPrincipal } from './dream-digest';
export { ReconciliationService, ReconcileJudge, buildPairInput } from './pipeline/reconcile.stage';
export type {
  ReconcileFactView,
  ReconcileInput,
  ReconcileSummary,
} from './pipeline/reconcile.stage';
export {
  isDedupCandidate,
  isContradictionCandidate,
  dedupBySimilarity,
  dedupByEntities,
} from './domain/reconcile-candidates';
export type { CandidateFacts } from './domain/reconcile-candidates';
export {
  ACTIVE_PROMPTS,
  EXTRACTION_PROMPT,
  VERIFICATION_PROMPT,
  RECONCILE_DEDUP_PROMPT,
  RECONCILE_CONTRADICTION_PROMPT,
} from './prompt-versions';
export type { PromptVersionRef } from './prompt-versions';
export { runGoldenEval, evalConfigSchema } from './eval-harness';
export type { EvalConfig, EvalMetrics, EvalRunResult } from './eval-harness';
export { runReconcileEval, loadPairCases, judgePair, pairCaseSchema } from './eval-reconcile';
export type {
  PairCase,
  PairOutcome,
  ReconcileEvalMetrics,
  ReconcileEvalResult,
} from './eval-reconcile';
export { seedMemoryFromSource } from './eval-seed';
// The dormant-flag consumption API (F2 handoff §3): the read-and-clear window
// into ingestion's dormant_flag table. Retrieval's open-loops read consumes it
// to mark an obligation "gone quiet"; never a write.
export { listOpenDormantFlags, clearDormantFlag } from './dormant-flags';
export type { OpenDormantFlag } from './dormant-flags';
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
  extractInnermostForward,
  stripQuotedReply,
  stripSignature,
  parseForwardedHeaders,
} from './pipeline/email-preprocess';
export type { ForwardedHeaders, IsolatedEmailContent } from './pipeline/email-preprocess';
