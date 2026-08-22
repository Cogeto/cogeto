import type { ChatFactDto, PreferredLanguage } from '@cogeto/shared';
import {
  mapMarkersToCitations,
  mapUnsourcedMarkers,
  sanitizeAnswer,
  sourceTypePromptLabel,
} from '@cogeto/shared';
import { serverT } from '../infrastructure/index';
import type { MemoryChange } from '../memory/index';
import { fenceUntrusted, untrustedBoundary } from '../model-gateway/index';
import type { ConversationTurn, TemporalIntent } from '../retrieval/index';
import type { OpenLoop, RetrievalMode } from '../retrieval/index';

/**
 * The answer prompt family (spec §12.3): versioned artifact in project/prompts/answer,
 * registered on worker boot alongside the ingestion families.
 */
export const ANSWER_PROMPT = { family: 'answer', version: 'v0010' } as const;

/** A transient attachment's contribution to the answer input (V2.2 item 5.1). */
export interface AnswerAttachment {
  name: string;
  text: string;
}

/**
 * The two deterministic chat replies. A deterministic string cannot mirror the
 * question's language, so it follows the anchor: the user's preferred language.
 * The words live in the server catalogue (V2.0 item 3.5); these constants stay
 * exported because the integration specs assert on them.
 */
export const NOTHING_OPEN = nothingOpen('en');

export function nothingOpen(lang: PreferredLanguage): string {
  return serverT(lang, 'chat', 'nothingOpen');
}

export function nothingOnRecord(lang: PreferredLanguage): string {
  return serverT(lang, 'chat', 'nothingOnRecord');
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
  /**
   * Transient conversation attachments (V2.2 item 5.1): each file's text is
   * FENCED (the document's words are untrusted input, exactly as they are in
   * extraction) under an `ATTACHED FILES` header. Absent or empty renders a
   * byte-identical pre-attachment input.
   */
  attachments?: AnswerAttachment[];
  /**
   * WHAT THE QUESTION IS ABOUT, resolved (issue #479, layer 1). The display
   * subject the pipeline ALREADY decided this turn is about, from the
   * ambiguity rule's named cluster or the conversation focus carried into it.
   *
   * This exists because the pipeline used to resolve the question and then
   * answer an unresolved one. `How does it look like?` reached the model as
   * those six words beside fifteen subjects, so it re-derived the referent by
   * elimination and hedged across three unrelated products. The subject was
   * known: it was computed deterministically, recorded on
   * `chat_message.ambiguity`, and thrown away.
   *
   * Set ONLY when a subject was genuinely resolved. A branch reached by score
   * alone resolved nothing, and asserting a subject there would invent one.
   */
  about?: string;
  /**
   * True when `about` came from the CONVERSATION FOCUS rather than from this
   * turn (issue #479, layer 3). Rendered as "carried over from earlier in this
   * conversation" so the model treats it as a working assumption it may
   * correct against the facts, not as something the user just said.
   */
  aboutCarriedOver?: boolean;
  /**
   * The resolved form of the question, when the rewriter produced one that
   * differs from what the user typed. `and the weight?` becomes something that
   * names its subject and its predicate; the raw question stays below it so
   * tone, phrasing and language still follow the user.
   */
  resolvedQuestion?: string;
  /**
   * The last few exchanges, oldest first (issue #479, layer 2). FENCED as
   * untrusted, exactly as attachments are: prior turns carry text the user or
   * a document wrote, and an instruction pasted into a chat must not survive
   * into the next answer. Present for the discourse a subject line cannot
   * express ("what about the other one", "and in metric"); absent or empty
   * renders a byte-identical input.
   */
  recentTurns?: { role: string; content: string }[];
}

/** The zero-retrieval path: no facts, no generation from thin air. */
export const NOTHING_ON_RECORD = nothingOnRecord('en');

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
    const label = sourceTypePromptLabel(fact.sourceType);
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

  if (extras.attachments && extras.attachments.length > 0) {
    // One boundary per call, shared by every fence in it (the SEC-4 rule).
    // The filename is flattened to one plain line so a name cannot imitate a
    // framing label; the text itself sits inside the fence.
    const boundary = untrustedBoundary();
    lines.push('', 'ATTACHED FILES (this conversation only, not remembered):');
    for (const attachment of extras.attachments) {
      lines.push(`File: ${oneLine(attachment.name)}`, fenceUntrusted(attachment.text, boundary));
    }
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

  // The conversation, in the ONE shape that cannot mislead: what the pipeline
  // already decided the turn is about, then the recent turns as raw material.
  //
  // Order matters. The subject comes first because it is the deterministic
  // conclusion; the turns come after as supporting context the model may read
  // but never has to reason from. The facts above remain the only source of
  // claims: this block resolves WHAT IS BEING ASKED, never what is true.
  if (extras.recentTurns && extras.recentTurns.length > 0) {
    const boundary = untrustedBoundary();
    lines.push(
      '',
      'RECENT TURNS (context for what is being asked; never a source of facts):',
      fenceUntrusted(
        extras.recentTurns
          .map((turn) => `${turn.role}: ${oneLine(turn.content, RECENT_TURN_CHARS)}`)
          .join('\n'),
        boundary,
      ),
    );
  }
  if (extras.about) {
    lines.push(
      '',
      `THE QUESTION IS ABOUT: ${oneLine(extras.about)}${
        extras.aboutCarriedOver ? ' (carried over from earlier in this conversation)' : ''
      }`,
    );
  }

  lines.push('', 'QUESTION:', question);
  // The resolved form sits UNDER the raw one: the user's own words drive tone,
  // phrasing and language (the anchor rules), while the resolved form removes
  // the pronoun the answerer would otherwise have to guess at.
  if (extras.resolvedQuestion && extras.resolvedQuestion.trim() !== question.trim()) {
    lines.push(`RESOLVED: ${oneLine(extras.resolvedQuestion, RECENT_TURN_CHARS)}`);
  }
  return lines.join('\n');
}

/**
 * Per-turn budget in the recent-turns block. Enough to identify a subject and a
 * predicate, far short of re-reading a whole answer: this block competes with
 * the facts for the model's attention and must never win.
 */
const RECENT_TURN_CHARS = 240;

/** Text as one plain line: no newlines, no marker-shaped runs, bounded. */
function oneLine(name: string, max = 120): string {
  return name.replace(/\s+/g, ' ').replace(/-{3,}/g, '-').trim().slice(0, max);
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
