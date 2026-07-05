/** Public interface of the ingestion bounded context (§A.1 rule 1). */
export { IngestionModule } from './ingestion.module';
export type { IngestionModuleOptions } from './ingestion.module';
export { IngestionPipeline, INGESTION_PIPELINE_JOB_TYPE } from './pipeline/pipeline.service';
export type { PipelineSummary } from './pipeline/pipeline.service';
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
