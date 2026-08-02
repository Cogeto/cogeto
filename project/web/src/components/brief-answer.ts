import { RESEARCH_MARKER_TOKEN } from '@cogeto/shared';
import type { AnswerSegment, ResearchCitationDto } from '@cogeto/shared';

/**
 * The brief's segment form: the skill brief is written in the
 * markdown-lite subset with [W#]/[M#] provenance markers and literal
 * `(unsourced)` tags (skill_brief/v0001). To render it through the house
 * ChatMarkdown renderer, markers become atomic chip segments (encoded as
 * `cite` segments carrying the MARKER — the brief renderer resolves them
 * against the run's citations) and `(unsourced)` becomes the canonical
 * unsourced segment. A marker without a stored citation stays literal text —
 * degrading, never guessing (the chat-markdown rule).
 */
const BRIEF_TOKEN_RE = new RegExp(`(${RESEARCH_MARKER_TOKEN}|\\(unsourced\\))`, 'g');

export function briefSegments(text: string, citations: ResearchCitationDto[]): AnswerSegment[] {
  const known = new Set(citations.map((c) => c.marker));
  const segments: AnswerSegment[] = [];
  let last = 0;
  const re = new RegExp(BRIEF_TOKEN_RE.source, 'g');
  const pushText = (value: string) => {
    if (value) segments.push({ kind: 'text', text: value });
  };
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const token = m[0];
    if (token === '(unsourced)') {
      pushText(text.slice(last, m.index));
      segments.push({ kind: 'unsourced' });
      last = m.index + token.length;
      continue;
    }
    if (known.has(token)) {
      pushText(text.slice(last, m.index));
      segments.push({ kind: 'cite', memoryId: token });
      last = m.index + token.length;
    }
    // An unknown marker stays part of the surrounding text run.
  }
  pushText(text.slice(last));
  return segments;
}
