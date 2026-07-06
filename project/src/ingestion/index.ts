/** Public interface of the ingestion bounded context (§A.1 rule 1). */
export { IngestionModule } from './ingestion.module';
export type { IngestionModuleOptions } from './ingestion.module';
export {
  IngestionPipeline,
  INGESTION_PIPELINE_JOB_TYPE,
  createIngestionPipeline,
} from './pipeline/pipeline.service';
export type { PipelineSummary, CreatePipelineOptions } from './pipeline/pipeline.service';
export { SOURCE_READERS } from './pipeline/source-reader';
export type { SourceReader, SourceItem } from './pipeline/source-reader';
export type { PipelineLog } from './pipeline/pipeline-log';
export { DreamingService, DREAM_JOB_TYPE, DREAM_CRONTAB } from './dreaming.service';
export type { DreamReport } from './dreaming.service';
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
