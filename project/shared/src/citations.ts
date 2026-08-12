/**
 * The one citation marker grammar (owner test F6;
 * extended by with the unsourced marker).
 *
 * Canonical, stored, renderer-trusted forms: `{{cite:<memory-uuid>}}` and
 * `{{unsourced}}`, and nothing else. The answer model emits short `[F1]`
 * markers for grounded claims and `[U]` after a claim from its own general
 * knowledge; the backend post-processor canonicalizes those and then strips
 * EVERY other bracketed or braced token. The renderer trusts only the
 * canonical forms. A raw `[F2, F4]`, a malformed brace, or a cite to an
 * unknown id can never reach the user; each stripped token is counted as a
 * citation violation (metadata only). An unsourced marker carries no id — it
 * marks the preceding claim as the model's own knowledge, never a source.
 */

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** Canonical citation token. Global; callers build fresh RegExp to avoid lastIndex bugs. */
export const CITATION_RE = new RegExp(`\\{\\{cite:(${UUID})\\}\\}`, 'g');

/** Canonical unsourced-claim token: model knowledge, marked. */
export const UNSOURCED_TOKEN = '{{unsourced}}';

/**
 * The RESEARCH and SKILL provenance marker (V2.0 item 3.7): `[W1]` cites a
 * fetched page, `[M3]` a remembered fact. A different grammar from the chat
 * `[F1]`/`{{cite:…}}` pair above, because a research answer is written against a
 * numbered list of supplied sources rather than against a fact map — kept in the
 * same file because there is exactly one place to look for what a marker is.
 *
 * The shape was spelled out as a literal in four places (two resolvers on the
 * server, the brief segmenter and the answer renderer in the SPA). It is one
 * shape and two USES, so it is one definition and two exported forms rather
 * than one form with a switch:
 *
 * - {@link RESEARCH_MARKER_CAPTURING} for resolvers, which read the kind and
 *   the index out of the match;
 * - {@link RESEARCH_MARKER_TOKEN} for `split`, where inner capture groups would
 *   leak into the result array, and for alternations that want the whole token.
 *
 * Sources, not RegExp objects: a `/g` RegExp carries `lastIndex`, so a shared
 * instance is a cross-call bug waiting to happen. Callers build their own, as
 * {@link CITATION_RE}'s callers already do.
 */
const MARKER_KIND = '[WM]';
const MARKER_INDEX = '\\d+';
/** `[W1]` with the kind and the index captured, in that order. */
export const RESEARCH_MARKER_CAPTURING = `\\[(${MARKER_KIND})(${MARKER_INDEX})\\]`;
/** `[W1]` as one whole token, no inner groups. */
export const RESEARCH_MARKER_TOKEN = `\\[${MARKER_KIND}${MARKER_INDEX}\\]`;

/**
 * Any "special token" that must be classified: a canonical cite, the canonical
 * unsourced marker, or junk to strip (double braces, single braces, or square
 * brackets). Ordered so the canonical forms are tried first.
 */
const TOKEN_RE = new RegExp(
  `\\{\\{cite:(${UUID})\\}\\}` + // 1: canonical cite (validate id)
    `|(\\{\\{unsourced\\}\\})` + // 2: canonical unsourced marker
    `|\\{\\{[^{}]*\\}\\}` + // double-brace junk
    `|\\{[^{}]*\\}` + // single-brace junk
    `|\\[[^\\[\\]]*\\]`, // bracket junk, e.g. [F2, F4]
  'g',
);

export type AnswerSegment =
  { kind: 'text'; text: string } | { kind: 'cite'; memoryId: string } | { kind: 'unsourced' };

export interface ScannedAnswer {
  segments: AnswerSegment[];
  violations: number;
}

function pushText(segments: AnswerSegment[], text: string): number {
  if (!text) return 0;
  // Orphan brace/bracket characters (from malformed tokens) never survive.
  const cleaned = text.replace(/[{}[\]]/g, '');
  if (cleaned) segments.push({ kind: 'text', text: cleaned });
  return cleaned === text ? 0 : 1;
}

/**
 * Split an answer into text and citation segments, stripping and counting every
 * non-conforming token. When `validMemoryIds` is given (live answers), a cite
 * counts only if its id was actually supplied; when omitted (already-sanitized
 * stored history), any syntactically valid cite is trusted.
 */
export function scanAnswer(text: string, validMemoryIds?: ReadonlySet<string>): ScannedAnswer {
  const segments: AnswerSegment[] = [];
  let violations = 0;
  let last = 0;
  const re = new RegExp(TOKEN_RE.source, 'g');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    violations += pushText(segments, text.slice(last, m.index));
    last = m.index + m[0].length;
    const citeId = m[1];
    if (citeId && (!validMemoryIds || validMemoryIds.has(citeId))) {
      segments.push({ kind: 'cite', memoryId: citeId });
    } else if (m[2]) {
      // The unsourced marker needs no id and is always valid: it claims
      // nothing about the user's sources — it admits the absence of one.
      segments.push({ kind: 'unsourced' });
    } else {
      violations += 1; // junk token, or a cite to an unsupplied id
    }
  }
  violations += pushText(segments, text.slice(last));
  return { segments, violations };
}

/**
 * The answer as PLAIN READING TEXT: every canonical token removed, nothing
 * else changed. What a search snippet, a preview or any non-rendering consumer
 * wants, because `{{cite:3f1c…}}` is renderer instruction, not something a
 * person should ever read (issue #530 follow-up).
 *
 * Whitespace around a removed token collapses, so a claim followed by its
 * chip does not leave a gap where the chip was.
 */
export function plainAnswerText(text: string): string {
  return scanAnswer(text)
    .segments.filter((segment) => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim();
}

/**
 * The SQL that strips those tokens before `ts_headline` builds a snippet.
 *
 * Stored answers are guaranteed to carry ONLY the canonical forms: the scribe
 * strips every other `{{…}}` token at write time. So this coarser pattern
 * removes exactly the canonical tokens and nothing else, which is what lets
 * the snippet be windowed in Postgres rather than reassembled in TypeScript.
 * `citations.spec.ts` asserts it agrees with `plainAnswerText` on canonical
 * input, so the two cannot drift apart silently.
 */
export const CITATION_STRIP_SQL_PATTERN = '\\{\\{[^}]*\\}\\}';

/** Re-serialize scanned segments to clean canonical text (for storage). */
export function sanitizeAnswer(
  text: string,
  validMemoryIds?: ReadonlySet<string>,
): { text: string; violations: number } {
  const { segments, violations } = scanAnswer(text, validMemoryIds);
  const out = segments
    .map((s) =>
      s.kind === 'text' ? s.text : s.kind === 'cite' ? `{{cite:${s.memoryId}}}` : UNSOURCED_TOKEN,
    )
    .join('');
  return { text: out, violations };
}

/**
 * Map the model's short `[F1]` markers (including comma clusters like
 * `[F2, F4]`) to canonical cites, using the supplied marker→memoryId map.
 * Unmapped markers are dropped here and swept by the sanitizer. This is the
 * F6 renderer-side mitigation that works even before the v0002 prompt.
 */
export function mapMarkersToCitations(
  text: string,
  markerMap: ReadonlyMap<string, string>,
): string {
  return text.replace(/\[\s*(F\d+(?:\s*,\s*F\d+)*)\s*\]/g, (_whole, cluster: string) => {
    return cluster
      .split(',')
      .map((raw) => markerMap.get(raw.trim()))
      .filter((id): id is string => Boolean(id))
      .map((id) => `{{cite:${id}}}`)
      .join('');
  });
}

/**
 * Map the model's short `[U]` unsourced markers to the canonical
 * `{{unsourced}}` token. Always applied: a model admitting a
 * claim is its own knowledge is marked, never stripped into an unmarked claim.
 * Case-insensitive and whitespace-tolerant, same posture as the `[F#]` map.
 */
export function mapUnsourcedMarkers(text: string): string {
  return text.replace(/\[\s*U\s*\]/gi, UNSOURCED_TOKEN);
}
