import type { TaskStatus } from './memory';

/** GET /api/tasks — the debug-grade task surface (F3-B; real UI is O2). */
export interface TaskDto {
  id: string;
  title: string;
  status: TaskStatus;
  primaryPerson: string | null;
  entities: string[];
  conditionText: string | null;
  conditionMet: boolean;
  due: string | null;
  dormant: boolean;
  /** Derived from an uncertain memory awaiting Review (decision 0013 r2). */
  fromUncertain: boolean;
  /** User-adopted from an observed memory ("Make this a task", decision 0054). */
  adopted: boolean;
  derivedFromMemoryId: string;
  closedByMemoryId: string | null;
  createdAt: string;
  /** Last transition time — the relative "closed N days ago" in history. */
  updatedAt: string;
}

/** GET /api/tasks/count — the nav badge (open + blocked, owner-scoped). */
export interface TaskCountDto {
  open: number;
}

/** What concluded a task (decision 0037). */
export type TaskConclusionType = 'closed' | 'condition_met';

/**
 * GET /api/tasks/:id/conclusions and GET /api/tasks/conclusions/:id — the
 * fact a task's conclusion produced (decision 0037): the deterministic
 * statement plus the inspectable chain. `memoryId` is the memory the pipeline
 * admitted from this conclusion — null while the capture is still in flight,
 * or after that memory was erased.
 */
export interface TaskConclusionDto {
  id: string;
  taskId: string | null;
  conclusionType: TaskConclusionType;
  statement: string;
  derivingMemoryId: string | null;
  triggerMemoryId: string | null;
  memoryId: string | null;
  createdAt: string;
}
