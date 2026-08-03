/**
 * Is this text worth having? (V2.1 item 4.1, the reading ladder.)
 *
 * The ladder's first question is not "does the page have a text layer" but "is
 * the text layer USABLE", and the difference is the whole reason scanned PDFs
 * pass through as done-with-zero-facts today. A scan very often carries a text
 * layer: a few dozen characters of ligature soup, a stray page number, or the
 * output of an OCR pass that was run once, badly, and baked into the file.
 * Present is not the same as usable, and treating it as usable is how a
 * two-hundred-page contract gets read as four characters and reported as read.
 *
 * The score is deterministic and costs no model call, which is the point:
 * routing decisions are made from arithmetic over the text itself, so a page's
 * path through the ladder is reproducible and explainable.
 */

export interface TextQuality {
  /** 0..1. Higher is better; the thresholds below say what counts as usable. */
  score: number;
  /** Characters of text found. */
  chars: number;
  /** Characters per square inch of page, or null when the page size is unknown. */
  density: number | null;
  /** Share of alphabetic words that look like real words. */
  wordRatio: number;
  /** Share of characters that are replacement, control, or private-use junk. */
  junkRatio: number;
  /** Why the score came out where it did; for the read report and for tests. */
  notes: string[];
}

/**
 * Characters per square inch, REPORTED but not used to decide.
 *
 * Density was in the decision first, and it was wrong: it makes a title page
 * reading "Consulting Agreement, 2026" indistinguishable from a scan's leftover
 * folio number, and it would send perfectly good text to OCR to be made
 * slightly worse. Everything density was supposed to catch, the character floor
 * and the word-quality gate already catch, and they catch it without punishing
 * a page for being short. The number stays on the report because it is useful
 * to a human reading it; it decides nothing.
 */
export const MIN_CHAR_DENSITY = 3;

/**
 * Fewer characters than this is page furniture rather than page content.
 *
 * The bracket is narrow and both ends are real. A running header or footer is
 * what a scan's text layer usually carries: `Page 3 of 12` is twelve
 * characters, `Confidential` is twelve. A genuinely short page still says
 * something: `Atlas proposal details` is twenty-two.
 *
 * 20 sits between them. It was 40 first, which was wrong in the direction that
 * costs work rather than truth: a real twenty-two-character line was declared
 * furniture and re-read from pixels, producing at best the same text after an
 * OCR pass nobody needed. The word-quality gate below does most of the real
 * filtering anyway, since a scan's ligature soup has no plausible words in it
 * at all; this floor exists only for the fragments that ARE words.
 */
export const MIN_MEANINGFUL_CHARS = 20;

/** Below this share of plausible words, the "text" is character soup. */
export const MIN_WORD_RATIO = 0.55;

/** Above this share of replacement/control characters, the layer is broken. */
export const MAX_JUNK_RATIO = 0.08;

/** The score at or above which text is taken and the ladder stops. */
export const USABLE_SCORE = 0.6;

/**
 * A word that a human would recognise as a word, judged WITHOUT a dictionary.
 *
 * A dictionary would have to cover English, Croatian and German, would be wrong
 * about names and part numbers, and would need shipping and maintaining. What
 * actually distinguishes real text from OCR soup is much coarser and language
 * independent: real words alternate vowels and consonants, are of ordinary
 * length, and do not mix scripts or stack four consonants in a row where the
 * language does not. Croatian genuinely does stack consonants (`vrt`, `krst`),
 * so the vowel rule allows syllabic r, which is exactly the kind of detail that
 * would make an English-tuned heuristic mark Croatian as junk.
 */
export function plausibleWord(word: string): boolean {
  const text = word.toLowerCase();
  if (text.length < 2) return false;
  if (text.length > 30) return false;
  // Letters only; a token with digits or symbols is not evidence either way, so
  // callers filter those out before counting.
  if (!/^[\p{L}'-]+$/u.test(text)) return false;
  // A vowel, or the syllabic r Croatian and Czech build words around.
  if (!/[aeiouyáéíóúäöüàèìòùčćšžđ]|r/u.test(text)) return false;
  // Five identical characters running, or five consonants with no syllabic r:
  // both are shapes no language produces and OCR produces constantly.
  if (/(.)\1{4,}/u.test(text)) return false;
  if (/[bcdfghjklmnpqstvwxz]{5,}/u.test(text)) return false;
  return true;
}

// Control characters are precisely what this pattern is for: a broken text
// layer is made of them, so matching them is the check, not an accident.
// eslint-disable-next-line no-control-regex
const JUNK_PATTERN = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\uE000-\uF8FF]/gu;

export interface PageDimensionsInches {
  width: number;
  height: number;
}

/** Scores a page's text. Pure arithmetic; no model call, no I/O. */
export function scoreText(text: string, page?: PageDimensionsInches | null): TextQuality {
  const notes: string[] = [];
  const chars = text.trim().length;
  const junkCount = (text.match(JUNK_PATTERN) ?? []).length;
  const junkRatio = chars === 0 ? 0 : junkCount / Math.max(text.length, 1);

  const words = text
    .split(/[^\p{L}'-]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 1);
  const plausible = words.filter(plausibleWord).length;
  const wordRatio = words.length === 0 ? 0 : plausible / words.length;

  const area = page && page.width > 0 && page.height > 0 ? page.width * page.height : null;
  const density = area ? chars / area : null;

  if (chars === 0) {
    return { score: 0, chars: 0, density, wordRatio: 0, junkRatio: 0, notes: ['no text at all'] };
  }

  // Three independent gates, each of which alone means "not usable text".
  let score = 1;
  if (chars < MIN_MEANINGFUL_CHARS) {
    score = Math.min(score, 0.2);
    notes.push(`only ${chars} characters, which is page furniture rather than content`);
  }
  if (wordRatio < MIN_WORD_RATIO) {
    score = Math.min(score, 0.3);
    notes.push(`only ${(wordRatio * 100).toFixed(0)}% of tokens look like words`);
  }
  if (junkRatio > MAX_JUNK_RATIO) {
    score = Math.min(score, 0.1);
    notes.push(`${(junkRatio * 100).toFixed(0)}% replacement or control characters`);
  }
  if (notes.length === 0) notes.push('reads as ordinary text');
  return { score, chars, density, wordRatio, junkRatio, notes };
}

export const isUsable = (quality: TextQuality): boolean => quality.score >= USABLE_SCORE;
