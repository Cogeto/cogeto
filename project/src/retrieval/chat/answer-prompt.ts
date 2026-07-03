import type { ChatFactDto } from '@cogeto/shared';
import { mapMarkersToCitations, sanitizeAnswer } from '@cogeto/shared';
import type { RetrievalMode } from '../retrieval.service';

/**
 * The answer prompt family (§B.7): versioned artifact in project/prompts/answer,
 * registered on worker boot alongside the ingestion families.
 */
export const ANSWER_PROMPT = { family: 'answer', version: 'v0002' } as const;

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
): string {
  const blocks = facts.map((fact) => {
    const validity =
      fact.validFrom || fact.validUntil
        ? ` | valid: ${fact.validFrom?.slice(0, 10) ?? '…'} to ${fact.validUntil?.slice(0, 10) ?? '…'}`
        : '';
    const label = fact.sourceType === 'user_note' ? 'note' : fact.sourceType.replace('_', ' ');
    const subject = fact.subjectEntity ? ` | about: ${fact.subjectEntity}` : '';
    return `[${fact.marker}] ${fact.claim ?? ''}\n    status: ${fact.status.replace('_', '-')}${subject} | source: ${label}${validity}`;
  });
  return [
    `MODE: ${mode}`,
    '',
    'FACTS ON RECORD (your only permitted knowledge):',
    ...blocks,
    '',
    'QUESTION:',
    question,
  ].join('\n');
}

/**
 * Canonicalize a raw model answer for storage and rendering (decision 0007
 * ruling 2): map the model's short `[F1]` markers to `{{cite:<uuid>}}`, then
 * strip EVERY other bracketed/braced token. The stored text is guaranteed to
 * contain only canonical cites to supplied memories; `violations` counts what
 * was stripped (metadata only — logged, never the content).
 */
export function toStoredAnswer(
  answer: string,
  facts: ChatFactDto[],
): { text: string; violations: number } {
  const markerMap = new Map(facts.map((fact) => [fact.marker, fact.memoryId]));
  const validIds = new Set(facts.map((fact) => fact.memoryId));
  const mapped = mapMarkersToCitations(answer, markerMap);
  return sanitizeAnswer(mapped, validIds);
}
