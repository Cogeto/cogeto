/** Public interface of the ingestion bounded context (§A.1 rule 1). */
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
// The deletion saga's pending-ingestion cancellation (QS-5, decision 0024) —
// memory defines the IngestionGuard port; this module implements it because it
// owns the pipeline job type. Composition roots bind it into MemoryModule.
export { PipelineIngestionGuard } from './pipeline/pipeline-guard';
export type { PipelineLog } from './pipeline/pipeline-log';
export { DreamingService, DREAM_JOB_TYPE, DREAM_CRONTAB, dreamRunStatus } from './dreaming.service';
export type { DreamReport, DreamRunStatus } from './dreaming.service';
// The digest endpoint + the port the tasks module fills with its section
// (F3 handoff §3). Exporting the controller lets the tasks module — the port's
// implementor — integration-test the composed endpoint (tasks → ingestion).
export { DreamingController } from './dreaming.controller';
// The digest builder — reused by the attention feed (Post-v1 Priority 2) so
// there is one digest, gated once — plus the dreaming activity series.
export { buildDreamDigest, buildDigestLines, dreamingActivityForPrincipal } from './dream-digest';
export { DIGEST_TASK_SECTION } from './digest-task-port';
export type { DigestTaskSectionPort, DigestTaskContext } from './digest-task-port';
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
export type { EvalConfig, EvalMetrics, EvalRunResult, DerivationTrapCase } from './eval-harness';
export { runReconcileEval, loadPairCases, judgePair, pairCaseSchema } from './eval-reconcile';
export type {
  PairCase,
  PairOutcome,
  ReconcileEvalMetrics,
  ReconcileEvalResult,
} from './eval-reconcile';
export { seedMemoryFromSource } from './eval-seed';
// The dormant-flag consumption API (F2 handoff §3): the task engine's window
// into ingestion's dormant_flag table — read and clear, never write.
export { listOpenDormantFlags, clearDormantFlag } from './dormant-flags';
export type { OpenDormantFlag } from './dormant-flags';
/**
 * Cross-module events the pipeline emits (decision 0013 ruling 2): ingestion
 * defines the job-type constants; tasks registers the handlers via the worker
 * composition root. Dependency direction stays tasks → ingestion, never back.
 */
export const TASK_DERIVE_JOB_TYPE = 'tasks.derive';
export const TASKS_BACKFILL_JOB_TYPE = 'tasks_backfill';
// The S3.5 deterministic date resolver (decision 0007 ruling 1) — reused by
// temporal query understanding (decision 0012 ruling 2); never duplicated.
export { resolveExpression } from './domain/temporal-resolver';
// Thread-aware email extraction pre-processing (Session O4 — email source):
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
