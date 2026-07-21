/** Public interface of the tasks bounded context (§A.1 rule 1). */
export { TasksModule } from './tasks.module';
export {
  TasksEngine,
  TASK_CONDITION_PROMPT,
  TASK_CLOSURE_PROMPT,
  TASK_PROMPTS,
  TASKS_REMINDERS_JOB_TYPE,
  TASKS_REMINDERS_CRONTAB,
  buildPairInput,
} from './tasks.engine';
export type { TaskEngineReport, TaskListFilters, ReminderReport } from './tasks.engine';
export { TasksCascade } from './tasks-cascade';
export { TasksDigestSection } from './tasks-digest';
export { runTaskEval, taskPairSchema } from './eval-tasks';
export type { TaskPairCase, TaskEvalMetrics, TaskEvalResult } from './eval-tasks';
export type { TaskRow, TaskConclusionRow } from './persistence/tables';
export {
  TaskConclusionSourceModule,
  TaskConclusionSourceReader,
  TaskConclusionSourceDeletion,
} from './task-conclusion.source-ports';
export { buildConclusionStatement, conclusionDate } from './task-conclusion';
export type { ConclusionType, ConclusionInput, TaskConclusionDto } from './task-conclusion';
