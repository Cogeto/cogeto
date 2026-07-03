import type { ChatFactDto } from '@cogeto/shared';

/**
 * The answer prompt family (§B.7): versioned artifact in project/prompts/answer,
 * registered on worker boot alongside the ingestion families.
 */
export const ANSWER_PROMPT = { family: 'answer', version: 'v0001' } as const;

/** The zero-retrieval path: no facts, no generation from thin air. */
export const NOTHING_ON_RECORD =
  'I have nothing on record that answers this. If you capture what you know as a ' +
  'note on the Memories page, I will remember it and can answer next time.';

/**
 * Structured fact blocks (claim, status, source label, validity) + the
 * question. Labeled context blocks, same discipline as extraction (research:
 * retrieval-and-pipeline §4). Memory ids never reach the model — markers do.
 */
export function buildAnswerInput(facts: ChatFactDto[], question: string): string {
  const blocks = facts.map((fact) => {
    const validity =
      fact.validFrom || fact.validUntil
        ? ` | valid: ${fact.validFrom?.slice(0, 10) ?? '…'} to ${fact.validUntil?.slice(0, 10) ?? '…'}`
        : '';
    const label = fact.sourceType === 'user_note' ? 'note' : fact.sourceType.replace('_', ' ');
    return `[${fact.marker}] ${fact.claim ?? ''}\n    status: ${fact.status.replace('_', '-')} | source: ${label}${validity}`;
  });
  return [
    'FACTS ON RECORD (your only permitted knowledge):',
    ...blocks,
    '',
    'QUESTION:',
    question,
  ].join('\n');
}

/**
 * Live streams cite with [F1]-style markers; storage swaps them for the stable
 * `[[mem:<memoryId>]]` form so history renders citation chips after the live
 * sources list is gone. Unknown markers are left as-is (visible, not invented).
 */
export function toStoredMarkers(answer: string, facts: ChatFactDto[]): string {
  const byMarker = new Map(facts.map((fact) => [fact.marker, fact.memoryId]));
  return answer.replace(/\[(F\d+)\]/g, (whole, marker: string) => {
    const memoryId = byMarker.get(marker);
    return memoryId ? `[[mem:${memoryId}]]` : whole;
  });
}
