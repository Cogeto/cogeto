/**
 * The whitespace normalizer, and the offset map that lets a reader keep its
 * segment boundaries through it.
 *
 * The PDF and DOCX readers must produce byte-identical text to what
 * `document-extract.ts` produced before the reader seam existed (V2.1 item 4.1,
 * issue A2): the golden set is scored against that text and the eval cache is
 * keyed on it. So the normalization rules are NOT reformulated here. What is
 * added is a scanning implementation of exactly the same rules that also
 * reports where every input offset landed in the output, because page and
 * paragraph boundaries are known in the RAW text and have to survive into the
 * normalized text to become locators.
 *
 * `normalizeWhitespaceReference` is the original regex chain, kept as the
 * executable definition of "unchanged". `normalize.spec.ts` asserts the scanner
 * agrees with it on a generated corpus of whitespace edge cases and on the real
 * document fixtures; if the two ever disagree, the scanner is wrong.
 */

/**
 * The original implementation, verbatim. Collapses runs of blank lines and
 * trailing spaces so chunking sees clean text.
 */
export function normalizeWhitespaceReference(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface NormalizedText {
  text: string;
  /**
   * Maps an offset in the input to its offset in `text`. Input positions that
   * were dropped (collapsed whitespace, trimmed edges) map to where the
   * surviving text moved to, so a mapped range can shrink but never invert.
   */
  map(inputOffset: number): number;
}

/**
 * Applies the same four rules as {@link normalizeWhitespaceReference} in one
 * pass, recording an output offset for every input offset.
 *
 * The rules, in the order the regex chain applies them:
 *   1. `\r\n` and lone `\r` become `\n`.
 *   2. spaces and tabs immediately before a newline are dropped.
 *   3. three or more consecutive newlines collapse to two.
 *   4. leading and trailing whitespace is trimmed.
 *
 * Rules 2 and 3 compose, which is the one subtlety: because rule 2 removes the
 * blanks between newlines first, `"\n \n \n"` reaches rule 3 as `"\n\n\n"` and
 * collapses to two. The scanner reproduces that by HOLDING spaces and tabs and
 * emitting them only when something other than a newline follows, so a run of
 * newlines survives blanks in between.
 */
export function normalizeWhitespaceWithMap(input: string): NormalizedText {
  const out: string[] = [];
  /** outputAt[i] = the output length at the moment input[i] was consumed. */
  const outputAt = new Array<number>(input.length + 1);
  const held: string[] = [];
  let newlineRun = 0;

  for (let i = 0; i < input.length; i += 1) {
    outputAt[i] = out.length;
    const char = input[i]!;

    if (char === '\r' || char === '\n') {
      if (char === '\r' && input[i + 1] === '\n') {
        i += 1;
        outputAt[i] = out.length; // rule 1: the pair is one newline
      }
      held.length = 0; // rule 2
      newlineRun += 1;
      if (newlineRun <= 2) out.push('\n'); // rule 3
      continue;
    }

    if (char === ' ' || char === '\t') {
      held.push(char); // dropped if a newline follows, emitted otherwise
      continue;
    }

    if (held.length > 0) {
      out.push(...held);
      held.length = 0;
    }
    newlineRun = 0;
    out.push(char);
  }
  if (held.length > 0) out.push(...held);
  outputAt[input.length] = out.length;

  const joined = out.join('');
  // Rule 4: trim, and shift every mapped offset by what the leading trim took.
  const leading = joined.length - joined.trimStart().length;
  const text = joined.trim();
  return {
    text,
    map(inputOffset: number): number {
      const clamped = Math.max(0, Math.min(inputOffset, input.length));
      const raw = outputAt[clamped] ?? text.length;
      return Math.max(0, Math.min(raw - leading, text.length));
    },
  };
}
