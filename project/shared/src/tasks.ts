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
