import type { Principal } from '@cogeto/shared';
import type { MemoryStore } from '../memory/index';
import type { TaskRow } from './persistence/tables';

/**
 * The read gate for shared-scope tasks (F3 handoff §5). A task inherits its
 * deriving memory's scope; a `shared` task is visible org-wide but only through
 * the SAME memory gates as its deriving fact — "no line for what the caller
 * cannot read". So: the caller's own tasks are always visible; a foreign task
 * (another owner's) is visible only when the caller can read its deriving
 * memory via `getManyForPrincipal`, which enforces scope + org + sensitive.
 *
 * Cross-org shared tasks never survive: the memory gate drops their deriving
 * fact, so the task drops with it. Private tasks of others are never even
 * candidates (the SQL filter admits only own-or-shared).
 */
export async function gateForeignTasks(
  memoryStore: MemoryStore,
  principal: Principal,
  rows: TaskRow[],
): Promise<TaskRow[]> {
  const foreign = rows.filter((t) => t.ownerId !== principal.userId);
  if (foreign.length === 0) return rows;
  const readable = await memoryStore.getManyForPrincipal(
    principal,
    foreign.map((t) => t.derivedFromMemoryId),
    { includeSensitive: true },
  );
  const visible = new Set(readable.map((m) => m.id));
  return rows.filter((t) => t.ownerId === principal.userId || visible.has(t.derivedFromMemoryId));
}
