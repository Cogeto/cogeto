import type { AnswerSegment } from '@cogeto/shared';

/**
 * Markdown-lite for chat messages (issue #211): the hand-rolled,
 * dependency-free subset the answer model actually emits — bold, italic,
 * inline code, bullet and numbered lists, `###` headings, `---` dividers,
 * paragraph breaks. Everything else stays literal, and malformed markup
 * degrades to plain text (an unclosed `**` simply renders its asterisks).
 *
 * This is PRESENTATION ONLY and runs after the citation sanitize/scan step:
 * chips arrive as atomic segments, keep their positions and order, and never
 * participate in formatting runs (a style opened before a chip and "closed"
 * after it stays literal — degrading, never guessing). The strict-grammar
 * guarantee is untouched.
 */

/** One inline piece of a line: styled text or an atomic chip segment. */
export type ChatInline =
  | { kind: 'text' | 'bold' | 'italic' | 'code'; text: string }
  | { kind: 'chip'; segment: Extract<AnswerSegment, { kind: 'cite' | 'unsourced' }> };

export type ChatBlock =
  | { kind: 'paragraph'; lines: ChatInline[][] }
  | { kind: 'heading'; content: ChatInline[] }
  | { kind: 'list'; ordered: boolean; items: ChatInline[][] }
  | { kind: 'divider' };

/** A line: raw pieces before inline styling (strings + chips, in order). */
type LinePiece = string | Extract<AnswerSegment, { kind: 'cite' | 'unsourced' }>;

const DIVIDER_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING_RE = /^\s*#{1,6}\s+(.*)$/;
const BULLET_RE = /^\s*(?:[-*•])\s+(.*)$/;
const ORDERED_RE = /^\s*\d{1,3}[.)]\s+(.*)$/;
/** Inline tokens, longest-first so `**bold**` wins over `*italic*`; the
 * italic delimiters must not touch another asterisk, so a malformed `**x*`
 * stays literal instead of half-styling. */
const INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|(?<!\*)\*[^*\n]+\*(?!\*))/g;

/** Split the sanitized segments into lines of atomic pieces. */
function toLines(segments: AnswerSegment[]): LinePiece[][] {
  const lines: LinePiece[][] = [[]];
  for (const segment of segments) {
    if (segment.kind !== 'text') {
      lines[lines.length - 1]!.push(segment);
      continue;
    }
    const parts = segment.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push(part);
    });
  }
  return lines;
}

/** Apply inline styles to one text fragment (chips are never inside one). */
function styleText(text: string): ChatInline[] {
  const out: ChatInline[] = [];
  let last = 0;
  const re = new RegExp(INLINE_RE.source, 'g');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    last = m.index + m[0].length;
    const token = m[0];
    if (token.startsWith('**')) out.push({ kind: 'bold', text: token.slice(2, -2) });
    else if (token.startsWith('`')) out.push({ kind: 'code', text: token.slice(1, -1) });
    else out.push({ kind: 'italic', text: token.slice(1, -1) });
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

function styleLine(pieces: LinePiece[]): ChatInline[] {
  return pieces.flatMap((piece) =>
    typeof piece === 'string' ? styleText(piece) : [{ kind: 'chip' as const, segment: piece }],
  );
}

/** Strip a matched line prefix from the FIRST string piece of the line. */
function stripPrefix(pieces: LinePiece[], rest: string): LinePiece[] {
  const [first, ...others] = pieces;
  if (typeof first !== 'string') return pieces;
  return rest ? [rest, ...others] : others;
}

const lineText = (pieces: LinePiece[]): string => (typeof pieces[0] === 'string' ? pieces[0] : '');

const isBlank = (pieces: LinePiece[]): boolean =>
  pieces.length === 0 ||
  (pieces.length === 1 && typeof pieces[0] === 'string' && !pieces[0].trim());

/**
 * Group sanitized answer segments into renderable blocks. Block classification
 * looks only at each line's LEADING text piece; a line whose only content is a
 * chip is an ordinary paragraph line, and a divider/heading match requires the
 * marker to be actual text (a chip can never form one).
 */
export function parseChatBlocks(segments: AnswerSegment[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let paragraph: ChatInline[][] = [];
  let list: { ordered: boolean; items: ChatInline[][] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', lines: paragraph });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };

  for (const pieces of toLines(segments)) {
    if (isBlank(pieces)) {
      flushParagraph();
      flushList();
      continue;
    }
    const head = lineText(pieces);
    if (pieces.length === 1 && DIVIDER_RE.test(head)) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'divider' });
      continue;
    }
    const heading = HEADING_RE.exec(head);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', content: styleLine(stripPrefix(pieces, heading[1]!)) });
      continue;
    }
    const bullet = BULLET_RE.exec(head);
    const ordered = bullet ? null : ORDERED_RE.exec(head);
    if (bullet || ordered) {
      flushParagraph();
      const wantOrdered = Boolean(ordered);
      if (!list || list.ordered !== wantOrdered) {
        flushList();
        list = { ordered: wantOrdered, items: [] };
      }
      list.items.push(styleLine(stripPrefix(pieces, (bullet ?? ordered)![1]!)));
      continue;
    }
    flushList();
    paragraph.push(styleLine(pieces));
  }
  flushParagraph();
  flushList();
  return blocks;
}
