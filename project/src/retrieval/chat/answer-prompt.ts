import type { ChatFactDto } from '@cogeto/shared';
import { mapMarkersToCitations, mapUnsourcedMarkers, sanitizeAnswer } from '@cogeto/shared';
import type { MemoryChange } from '../../memory/index';
import type { TaskRow } from '../../tasks/index';
import type { ConversationTurn, TemporalIntent } from '../query-rewrite';
import type { RetrievalMode } from '../retrieval.service';

/**
 * The answer prompt family (§B.7): versioned artifact in project/prompts/answer,
 * registered on worker boot alongside the ingestion families.
 */
export const ANSWER_PROMPT = { family: 'answer', version: 'v0006' } as const;

/** The zero-open-loops path (F3-B): a true "all clear", not a data gap. */
export const NOTHING_OPEN =
  'Nothing is still open — every commitment on record is done or dismissed.';

/**
 * Localized forms of the two deterministic chat replies (decision 0052): a
 * deterministic string cannot mirror the question's language, so it follows
 * the anchor — the user's preferred language.
 */
export function nothingOpen(lang: 'en' | 'hr'): string {
  return lang === 'hr'
    ? 'Ništa više nije otvoreno — svaka zabilježena obveza je dovršena ili odbačena.'
    : NOTHING_OPEN;
}

export function nothingOnRecord(lang: 'en' | 'hr'): string {
  return lang === 'hr'
    ? 'O tome još nemam ništa. Ako to zabilježiš kao bilješku na stranici Memories, zapamtit ću i moći odgovoriti sljedeći put.'
    : NOTHING_ON_RECORD;
}

export interface AnswerTemporalContext {
  temporal?: TemporalIntent;
  changes?: MemoryChange[];
  /** Open/blocked tasks, when mode is tasks (decision 0013 ruling 7). */
  tasks?: TaskRow[];
  /**
   * Knowledge-class question (decision 0046): emits the `GENERAL KNOWLEDGE:
   * allowed` line, permitting marked `[U]` statements from model knowledge.
   * Memory-first stands: provided facts still ground and win.
   */
  knowledge?: boolean;
  /**
   * The rendered now-block (P6.6, decision 0051): NOW + USER CONTEXT +
   * LANGUAGE lines, built by infrastructure's buildContextBlock. Prepended
   * before MODE; absent means the block simply does not appear.
   */
  context?: string;
}

/** The zero-retrieval path: no facts, no generation from thin air. */
export const NOTHING_ON_RECORD =
  'I don’t have anything on that yet. If you capture it as a note on the Memories ' +
  'page, I’ll remember it and can answer next time.';

/**
 * Structured fact blocks (claim, subject, status, source label, validity) + the
 * mode + the question. Labeled context blocks, same discipline as extraction
 * (research: retrieval-and-pipeline §4). Memory ids never reach the model —
 * markers do; the subject entity lets the answerer attribute correctly (F1/F4).
 */
export function buildAnswerInput(
  facts: ChatFactDto[],
  question: string,
  mode: RetrievalMode = 'default',
  extras: AnswerTemporalContext = {},
): string {
  const markerById = new Map(facts.map((fact) => [fact.memoryId, fact.marker]));
  const blocks = facts.map((fact) => {
    const validity =
      fact.validFrom || fact.validUntil
        ? ` | valid: ${fact.validFrom?.slice(0, 10) ?? '…'} to ${fact.validUntil?.slice(0, 10) ?? '…'}`
        : '';
    const label = fact.sourceType === 'user_note' ? 'note' : fact.sourceType.replace('_', ' ');
    const subject = fact.subjectEntity ? ` | about: ${fact.subjectEntity}` : '';
    // The past-framing marker (decision 0012 ruling 6): the model may never
    // present a PAST BELIEF fact as current.
    const past = fact.pastBelief
      ? ` | PAST BELIEF${
          fact.supersededBy && markerById.has(fact.supersededBy)
            ? ` — superseded by [${markerById.get(fact.supersededBy)}]`
            : ''
        }`
      : '';
    return `[${fact.marker}] ${fact.claim ?? ''}\n    status: ${fact.status.replace('_', '-')}${subject} | source: ${label}${validity}${past}`;
  });

  const lines = [
    ...(extras.context ? [extras.context, ''] : []),
    `MODE: ${mode}${extras.temporal ? ` (${extras.temporal.kind})` : ''}`,
    '',
    extras.knowledge
      ? 'FACTS ON RECORD (your only knowledge of the user’s world):'
      : 'FACTS ON RECORD (your only permitted knowledge):',
    ...(blocks.length > 0 ? blocks : ['(none)']),
  ];

  if (extras.knowledge) {
    lines.push('', 'GENERAL KNOWLEDGE: allowed');
  }

  if (extras.temporal?.at) {
    lines.push('', `ASKED ABOUT THE STATE AT: ${extras.temporal.at.toISOString().slice(0, 10)}`);
  }
  if (extras.tasks && extras.tasks.length > 0) {
    lines.push('', 'OPEN LOOPS (the tasks still standing — answer from THESE):');
    for (const t of extras.tasks) {
      const marker = markerById.get(t.derivedFromMemoryId);
      const parts = [
        `- ${marker ? `[${marker}] ` : ''}${t.title}`,
        t.status === 'blocked_on_condition' && t.conditionText
          ? `| waiting on: ${t.conditionText}`
          : '',
        t.due ? `| due: ${t.due.toISOString().slice(0, 10)}` : '',
        t.dormant ? '| quiet for a while' : '',
        t.fromUncertain ? '| unconfirmed (awaiting review)' : '',
      ].filter(Boolean);
      lines.push(parts.join(' '));
    }
  }

  if (extras.changes && extras.changes.length > 0) {
    lines.push('', `CHANGES SINCE ${extras.temporal?.since?.toISOString().slice(0, 10) ?? '…'}:`);
    for (const change of extras.changes) {
      const marker = markerById.get(change.memory.id);
      const ref = marker ? `[${marker}]` : '(not cited)';
      const what =
        change.kind === 'learned'
          ? 'learned'
          : change.kind === 'superseded'
            ? `superseded${
                change.detail.supersededBy && markerById.has(change.detail.supersededBy)
                  ? ` by [${markerById.get(change.detail.supersededBy)}]`
                  : ''
              }`
            : `status ${change.detail.from ?? '…'} → ${change.detail.to ?? '…'}`;
      lines.push(`- ${change.at.toISOString().slice(0, 10)}: ${ref} ${what}`);
    }
  }

  lines.push('', 'QUESTION:', question);
  return lines.join('\n');
}

/**
 * The smalltalk-mode input (decision 0046): no facts block, the recent turns
 * for tone, the turn itself. The same answer artifact serves it — MODE gates
 * the behavior.
 */
export function buildSmallTalkInput(
  history: ConversationTurn[],
  question: string,
  context?: string,
): string {
  const turns = history.length
    ? history.map((t) => `${t.role}: ${t.content}`).join('\n')
    : '(none)';
  return [
    ...(context ? [context, ''] : []),
    'MODE: smalltalk',
    '',
    'RECENT TURNS:',
    turns,
    '',
    'QUESTION:',
    question,
  ].join('\n');
}

/**
 * Canonicalize a raw model answer for storage and rendering (decision 0007
 * ruling 2; extended by 0046): map the model's short `[F1]` markers to
 * `{{cite:<uuid>}}` and its `[U]` markers to `{{unsourced}}`, then strip EVERY
 * other bracketed/braced token. The stored text is guaranteed to contain only
 * canonical cites to supplied memories and canonical unsourced markers;
 * `violations` counts what was stripped (metadata only — logged, never the
 * content). `[U]` is mapped in every mode: a model admitting a claim is its
 * own knowledge is marked, never stripped into an unmarked claim.
 */
export function toStoredAnswer(
  answer: string,
  facts: ChatFactDto[],
): { text: string; violations: number } {
  const markerMap = new Map(facts.map((fact) => [fact.marker, fact.memoryId]));
  const validIds = new Set(facts.map((fact) => fact.memoryId));
  const mapped = mapUnsourcedMarkers(mapMarkersToCitations(answer, markerMap));
  return sanitizeAnswer(mapped, validIds);
}
