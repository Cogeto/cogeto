import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { DreamDigestLine, Principal } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { MemoryStore } from '../memory/index';
import type { DigestTaskContext, DigestTaskSectionPort } from '../ingestion/index';
import { task } from './persistence/tables';
import type { TaskRow } from './persistence/tables';
import { gateForeignTasks } from './task-visibility';

/** The tasks section adds at most three lines to the panel (F3 handoff §3). */
const MAX_TASK_LINES = 3;
/** Task lines deep-link to the actionable surface (F3 §3 allows /tasks). */
const TASKS_HREF = '/tasks';
const MS_DAY = 86_400_000;

/**
 * The digest's TASKS section (F3 handoff §3), implementing ingestion's
 * `DigestTaskSectionPort`. Reads the tasks module's OWN table (module-private —
 * legitimate here) and resolves visibility through the gated MemoryStore, so a
 * shared task appears only when its deriving fact is readable by the caller —
 * the same gate as every other digest line. Ordering per §3: due-today/overdue
 * → newly unblocked → dormant; capped at three with an overflow fold.
 *
 * A task is NOT written here — this is a pure read (F3 §6: no task writes
 * outside the engine and the three user operations). The due/dormant lines
 * render tasks that the reminders pass has already stamped (§2).
 */
@Injectable()
export class TasksDigestSection implements DigestTaskSectionPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly memoryStore: MemoryStore,
  ) {}

  async taskLines(principal: Principal, ctx: DigestTaskContext): Promise<DreamDigestLine[]> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(task)
      .where(
        and(
          or(eq(task.ownerId, principal.userId), eq(task.scope, 'shared')),
          inArray(task.status, ['open', 'blocked_on_condition']),
        ),
      )
      .orderBy(sql`${task.due} ASC NULLS LAST`, desc(task.updatedAt))
      .limit(200);
    const visible = await gateForeignTasks(this.memoryStore, principal, rows);

    const seen = new Set<string>();
    const take = (t: TaskRow): boolean => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    };

    // 1. Due today / overdue — tasks the reminders pass stamped; overdue first.
    const due = visible
      .filter((t) => t.dueRemindedAt !== null && t.due !== null)
      .sort((a, b) => a.due!.getTime() - b.due!.getTime());
    // 2. Newly unblocked — a condition met since the last run (needs an anchor).
    const unblocked = ctx.scopeFrom
      ? visible.filter(
          (t) =>
            t.status === 'open' &&
            t.conditionMet &&
            t.conditionMetByMemoryId !== null &&
            t.updatedAt >= ctx.scopeFrom!,
        )
      : [];
    // 3. Dormant nudges — tasks the reminders pass flagged as gone quiet.
    const dormant = visible.filter((t) => t.dormantRemindedAt !== null);

    const ordered: DreamDigestLine[] = [];
    for (const t of due) if (take(t)) ordered.push(dueLine(t, now));
    for (const t of unblocked) if (take(t)) ordered.push(line(`Now unblocked: ${label(t)}`));
    for (const t of dormant) if (take(t)) ordered.push(line(`Gone quiet: ${label(t)}`));

    if (ordered.length <= MAX_TASK_LINES) return ordered;
    const shown = ordered.slice(0, MAX_TASK_LINES - 1);
    shown.push(line(`…and ${ordered.length - (MAX_TASK_LINES - 1)} more tasks`));
    return shown;
  }
}

function line(text: string): DreamDigestLine {
  return { text, href: TASKS_HREF, section: 'tasks' };
}

function dueLine(t: TaskRow, now: Date): DreamDigestLine {
  const days = Math.round((t.due!.getTime() - now.getTime()) / MS_DAY);
  if (days < 0) {
    const n = -days;
    return line(`Overdue by ${n === 1 ? '1 day' : `${n} days`}: ${label(t)}`);
  }
  if (days === 0) return line(`Due today: ${label(t)}`);
  return line(`Due ${days === 1 ? 'tomorrow' : `in ${days} days`}: ${label(t)}`);
}

/** A short handle for a task: its title, trimmed for a one-line digest entry. */
function label(t: TaskRow): string {
  const title = t.title.trim();
  return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}
