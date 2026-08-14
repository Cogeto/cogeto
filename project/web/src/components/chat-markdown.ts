import type { AnswerSegment } from '@cogeto/shared';

/**
 * Markdown-lite for chat messages: the hand-rolled,
 * dependency-free subset the answer model actually emits — fenced code blocks,
 * bold, italic, inline code, bullet and numbered lists, `###` headings, `---`
 * dividers, paragraph breaks. Everything else stays literal, and malformed
 * markup degrades to plain text (an unclosed `**` simply renders its
 * asterisks).
 *
 * FENCED CODE IS CONSUMED FIRST, before any line is classified or any inline
 * style is applied (issue #581). Not a nicety: without it a Python block was
 * not merely unstyled, it was CORRUPTED — `**kwargs` rendered bold, `*args`
 * italic, a `#` comment became a heading, `- x` a bullet and `1.` an ordered
 * list. Inside a fence every character is literal, which is the only thing
 * "render code" can mean.
 *
 * This is PRESENTATION ONLY and runs after the citation sanitize/scan step
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
  /** A fenced block. `lang` is the fence's info string, lowercased, or null. */
  | { kind: 'code'; lang: string | null; code: string }
  | { kind: 'heading'; content: ChatInline[] }
  | { kind: 'list'; ordered: boolean; items: ChatInline[][] }
  | { kind: 'divider' };

/** A line: raw pieces before inline styling (strings + chips, in order). */
type LinePiece = string | Extract<AnswerSegment, { kind: 'cite' | 'unsourced' }>;

/**
 * A fence opens on three or more backticks or tildes. The info string is
 * taken up to the first space (```python title=x → python) and lowercased; a
 * closing fence must use the SAME character and be at least as long, which is
 * what lets a ``` inside a ~~~ block stay literal.
 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
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

  const lines = toLines(segments);
  for (let index = 0; index < lines.length; index += 1) {
    const pieces = lines[index]!;
    /**
     * A fence swallows every following line verbatim until its own closing
     * fence, so nothing inside is ever classified or styled. A fence that is
     * never closed runs to the end of the message rather than reverting to
     * prose: a half-streamed answer shows the code it has so far, which is
     * what a reader wants while it arrives.
     *
     * The whole line must be text. A chip cannot open a fence, for the same
     * reason it cannot open a heading.
     */
    const fence = pieces.length === 1 ? FENCE_RE.exec(lineText(pieces)) : null;
    if (fence) {
      flushParagraph();
      flushList();
      const marker = fence[1]!;
      const closer = new RegExp(
        `^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`,
      );
      const body: string[] = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor]!;
        if (candidate.length === 1 && closer.test(lineText(candidate))) break;
        if (candidate.length === 0) {
          body.push('');
          continue;
        }
        // Inside a fence a chip has no meaning; render its literal text so the
        // code is byte-exact rather than silently missing a token.
        body.push(candidate.map((piece) => (typeof piece === 'string' ? piece : '')).join(''));
      }
      blocks.push({
        kind: 'code',
        lang: fence[2] ? fence[2].toLowerCase() : null,
        code: body.join('\n'),
      });
      index = cursor; // the closing fence itself is consumed (or we hit the end)
      continue;
    }
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
