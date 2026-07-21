import type { TaskConclusionDto } from '@cogeto/shared';
import type { TaskConclusionRow } from './persistence/tables';

export type { TaskConclusionDto };

/**
 * Deterministic conclusion phrasing (decision 0037 ruling 4): the statement is
 * composed from task fields and the triggering fact — NO model call, so the
 * conclusion path can never be gated, garbled, or delayed by a model. Quoted
 * source text keeps its original language; the connective phrasing is English
 * in v1 (the extractor is bilingual and normalizes downstream).
 */

export type ConclusionType = 'closed' | 'condition_met';

export interface ConclusionInput {
  type: ConclusionType;
  /** The task title — the deriving memory's content verbatim (0013 ruling 2). */
  taskTitle: string;
  /** When the underlying commitment was recorded (deriving memory). */
  recordedAt: Date;
  /** When the conclusion happened. */
  concludedAt: Date;
  /** The satisfying/closing fact's content; null for a user-completed task. */
  triggerContent: string | null;
  /** The task's waiting condition (condition_met conclusions only). */
  conditionText?: string | null;
}

/** Quoted fragments are capped so a pathological title cannot balloon the
 * statement past the pipeline's parse caps (QS-6). */
const QUOTE_CAP = 200;

const clip = (text: string): string => {
  const t = text.trim().replace(/[.!?]+$/, '');
  return t.length > QUOTE_CAP ? `${t.slice(0, QUOTE_CAP - 1)}…` : t;
};

/** 14 July 2026 — fixed locale + UTC so the statement is fully deterministic. */
export function conclusionDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function buildConclusionStatement(input: ConclusionInput): string {
  const title = clip(input.taskTitle);
  const recorded = conclusionDate(input.recordedAt);
  const concluded = conclusionDate(input.concludedAt);
  if (input.type === 'condition_met') {
    const condition = clip(input.conditionText ?? 'the stated condition');
    const trigger = clip(input.triggerContent ?? '');
    return (
      `${trigger} — on ${concluded} this satisfied the condition "${condition}" ` +
      `for the commitment "${title}" recorded on ${recorded}.`
    );
  }
  if (input.triggerContent) {
    return (
      `${clip(input.triggerContent)} — on ${concluded} this completed the commitment ` +
      `"${title}" recorded on ${recorded}.`
    );
  }
  return `The commitment "${title}" recorded on ${recorded} was completed on ${concluded}.`;
}

export function toConclusionDto(
  row: TaskConclusionRow,
  memoryId: string | null,
): TaskConclusionDto {
  return {
    id: row.id,
    taskId: row.taskId,
    conclusionType: row.conclusionType,
    statement: row.statement,
    derivingMemoryId: row.derivingMemoryId,
    triggerMemoryId: row.triggerMemoryId,
    memoryId,
    createdAt: row.createdAt.toISOString(),
  };
}
