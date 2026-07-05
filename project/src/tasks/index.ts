/** Public interface of the tasks bounded context (§A.1 rule 1). */
export { TasksModule } from './tasks.module';
export {
  TasksEngine,
  TASK_CONDITION_PROMPT,
  TASK_CLOSURE_PROMPT,
  TASK_PROMPTS,
  buildPairInput,
} from './tasks.engine';
export type { TaskEngineReport, TaskListFilters } from './tasks.engine';
export { TasksCascade } from './tasks-cascade';
export { runTaskEval, taskPairSchema } from './eval-tasks';
export type { TaskPairCase, TaskEvalMetrics, TaskEvalResult } from './eval-tasks';
export type { TaskRow } from './persistence/tables';
