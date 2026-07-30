import type { ChatFactDto } from '@cogeto/shared';
import { mapMarkersToCitations, mapUnsourcedMarkers, sanitizeAnswer } from '@cogeto/shared';
import type { MemoryChange } from '../../memory/index';
import type { ConversationTurn, TemporalIntent } from '../query-rewrite';
import type { OpenLoop, RetrievalMode } from '../retrieval.service';

/**
 * The answer prompt family (spec §12.3): versioned artifact in project/prompts/answer,
 * registered on worker boot alongside the ingestion families.
 */
export const ANSWER_PROMPT = { family: 'answer', version: 'v0007' } as const;

/** The zero-open-loops path: a true "all clear", not a data gap. */
export const NOTHING_OPEN = 'Nothing is still open — nothing on record is waiting on you.';

/**
 * Localized forms of the two deterministic chat replies: a
 * deterministic string cannot mirror the question's language, so it follows
 * the anchor — the user's preferred language.
 */
export function nothingOpen(lang: 'en' | 'hr'): string {
  return lang === 'hr'
    ? 'Ništa više nije otvoreno — ništa zabilježeno ne čeka na tebe.'
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
  /** What is still standing, when mode is open_loops. */
  openLoops?: OpenLoop[];
  /**
   * Knowledge-class question: emits the `GENERAL KNOWLEDGE
   * allowed` line, permitting marked `[U]` statements from model knowledge.
   * Memory-first stands: provided facts still ground and win.
   */
  knowledge?: boolean;
  /**
   * The rendered now-block: NOW + USER CONTEXT +
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
    // The past-framing marker: the model may never
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

  // SEC-4 note, deliberate: the facts block is NOT fenced.
  //
  // Fencing it was tried and measurably harmful. The answerer's entire job is to
  // trust and cite these claims, and wrapping them in "untrusted data" markers
  // told it not to: chat coverage fell from 86% to 14% on who_is_ana and 100% to
  // 67% on atlas_scope, well through the mean-coverage gate.
  //
  // It is also the wrong place for the defence. These are the instance's own
  // verified, stored memories, not raw third-party text: each one already passed
  // extraction (fenced, with the forged-framing guard) and the independent
  // verification pass, and carries provenance back to its source. Injected
  // content is stopped where it enters, at ingestion. The fence stays on RAW
  // untrusted spans: document text in extraction, the passage and context in
  // verification, and fetched page text in research synthesis and skill briefs.
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
  if (extras.openLoops && extras.openLoops.length > 0) {
    lines.push('', 'OPEN LOOPS (what is still standing — answer from THESE):');
    for (const loop of extras.openLoops) {
      const marker = markerById.get(loop.memory.id);
      const parts = [
        `- ${marker ? `[${marker}] ` : ''}${(loop.memory.content ?? '').trim()}`,
        loop.memory.validUntil ? `| due: ${loop.memory.validUntil.toISOString().slice(0, 10)}` : '',
        loop.dormant ? '| quiet for a while' : '',
        loop.memory.status === 'uncertain' ? '| unconfirmed' : '',
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
 * The smalltalk-mode input: no facts block, the recent turns
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
 * Canonicalize a raw model answer for storage and rendering (
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
