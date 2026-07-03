/** Public interface of the ingestion bounded context (§A.1 rule 1). */
export { IngestionModule } from './ingestion.module';
export type { IngestionModuleOptions } from './ingestion.module';
export { IngestionPipeline, INGESTION_PIPELINE_JOB_TYPE } from './pipeline/pipeline.service';
export type { PipelineSummary } from './pipeline/pipeline.service';
export { SOURCE_READERS } from './pipeline/source-reader';
export type { SourceReader, SourceItem } from './pipeline/source-reader';
export type { PipelineLog } from './pipeline/pipeline-log';
export { ACTIVE_PROMPTS, EXTRACTION_PROMPT, VERIFICATION_PROMPT } from './prompt-versions';
export type { PromptVersionRef } from './prompt-versions';
export { runGoldenEval, evalConfigSchema } from './eval-harness';
export type { EvalConfig, EvalMetrics, EvalRunResult } from './eval-harness';
export { seedMemoryFromSource } from './eval-seed';
