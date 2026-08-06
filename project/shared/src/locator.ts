/**
 * Where a piece of read text came from, structurally.
 *
 * This is the point of the reader seam (V2.1 item 4.1). A reader does not
 * return prose with "page 4" written into it: it returns text plus a locator
 * per segment, so the span a fact was verified against can be rendered as an
 * exact position in the original document. V2.2 (source detail, spec §5.2) and
 * V2.3 (the findings report) render these, which is why the shape is defined
 * now rather than left as a free-text string that would have to be parsed back.
 *
 * Since V2.2 item 5.2 the consumers exist, which is why this lives in
 * `@cogeto/shared` (the leaf both tiers and every module may read): the
 * pipeline persists each admitted fact's locators at admission
 * (`verification_result.span_locators`), the Sources surface renders them,
 * and the findings report (V2.3) prints them. The reader seam still produces
 * segments exactly as before; `files/reading/locator.ts` re-exports this
 * module so reader internals did not move.
 */

/** The granularity a reader can resolve a span to. */
export type ReadGranularity = 'page' | 'paragraph' | 'sheet_row' | 'document';

/** A page of a paginated document (PDF). 1-based, as the reader shows it. */
export interface PageLocator {
  kind: 'page';
  page: number;
  /**
   * Which tier of the reading ladder produced this page's text (V2.1 item 4.1).
   * Absent means the page's own text layer, which is also what every locator
   * produced before the ladder existed meant.
   *
   * It is on the LOCATOR rather than beside it because this is the thing the
   * Sources view and the findings report render: a fact transcribed from a
   * photograph by a model is weaker evidence than one lifted from a text layer,
   * and a reader deserves to see which they are looking at.
   */
  tier?: 'text' | 'ocr' | 'vision';
}

/** A paragraph of a flowed document (DOCX). 1-based. */
export interface ParagraphLocator {
  kind: 'paragraph';
  paragraph: number;
}

/**
 * A row of a tabular document (XLSX, CSV), with the columns the statement was
 * built from. `sheet` is null for single-table formats (CSV has no sheets);
 * `row` and `cellRange` use the spreadsheet's own 1-based numbering, so a
 * locator can be typed straight into the name box of a spreadsheet program.
 */
export interface SheetRowLocator {
  kind: 'sheet_row';
  sheet: string | null;
  /** 1-based position of the sheet in the workbook; 1 for a single-table file. */
  sheetIndex: number;
  row: number;
  /** A1-style range covering exactly the cells this text was built from. */
  cellRange: string;
  /** Header labels of the columns involved, in the order they appear. */
  columns: string[];
}

/** The whole document: the honest answer when a reader can resolve no finer. */
export interface DocumentLocator {
  kind: 'document';
}

export type ReadLocator = PageLocator | ParagraphLocator | SheetRowLocator | DocumentLocator;

/**
 * A half-open `[start, end)` character range of the produced text and where it
 * came from. Segments are emitted in text order and never overlap.
 */
export interface ReadSegment {
  start: number;
  end: number;
  locator: ReadLocator;
}

/** Renders a locator for a log line or a test name. Never user-visible copy. */
export function describeLocator(locator: ReadLocator): string {
  switch (locator.kind) {
    case 'page':
      return locator.tier && locator.tier !== 'text'
        ? `page ${locator.page} (${locator.tier})`
        : `page ${locator.page}`;
    case 'paragraph':
      return `paragraph ${locator.paragraph}`;
    case 'sheet_row':
      return locator.sheet === null
        ? `row ${locator.row} (${locator.cellRange})`
        : `${locator.sheet}!${locator.cellRange}`;
    case 'document':
      return 'document';
  }
}

/**
 * Resolves a verbatim span back to the segments it covers.
 *
 * Verification (spec §2.3) hands the model a chunk and gets back a span quoted
 * from it, so the span is expected to occur verbatim in the read text. Three
 * ways of matching are offered, in order, and every one of them requires the
 * span's own words to be PRESENT:
 *
 * 1. verbatim;
 * 2. whitespace-relaxed, for a model that re-wrapped or re-indented the quote;
 * 3. **elided**, for a model that quoted a long row as
 *    `Supplier: Adriatic Foods; ... Amount due EUR: 18400`. Every fragment
 *    around the ellipsis must occur, in order, inside ONE segment. That is
 *    still exact evidence: an elided quote is a shortened quote, not a
 *    paraphrase, and the fragments either are in that row or they are not.
 *    Without this, most spreadsheet facts resolve to nothing, because eliding
 *    the middle of a wide row is what models actually do.
 *
 * A span that cannot be found by any of the three returns [], never a guessed
 * position. That empty result is the correct answer to "we cannot say where
 * this came from", and rendering must say so rather than pick the first page.
 */
export function locateSpan(
  text: string,
  segments: readonly ReadSegment[],
  span: string,
): ReadLocator[] {
  const needle = span.trim();
  if (!needle || segments.length === 0) return [];

  let start = text.indexOf(needle);
  let end = start + needle.length;
  if (start === -1) {
    const relaxed = findWhitespaceRelaxed(text, needle);
    if (relaxed) {
      [start, end] = relaxed;
    } else {
      return locateElided(text, segments, needle);
    }
  }

  return segments
    .filter((segment) => segment.start < end && start < segment.end)
    .map((segment) => segment.locator);
}

/** How short a fragment may be and still count as evidence of position. */
const MIN_FRAGMENT_CHARS = 4;

/**
 * Resolves a span the model shortened with an ellipsis: every fragment must
 * appear, in order, within a single segment. Segments that satisfy that are
 * returned; when several do, all of them are, because each genuinely contains
 * the quoted words and narrowing further would be a guess.
 */
function locateElided(text: string, segments: readonly ReadSegment[], span: string): ReadLocator[] {
  const fragments = span
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= MIN_FRAGMENT_CHARS);
  if (fragments.length < 2) return [];

  // Compared with whitespace collapsed, the same tolerance the whole-span
  // search already grants: a cell holding a quoted field with an embedded
  // newline comes back from the model as one flowed line, and that is the same
  // words in the same order, not different evidence.
  const wanted = fragments.map(collapseWhitespace);
  return segments
    .filter((segment) => {
      const body = collapseWhitespace(text.slice(segment.start, segment.end));
      let at = 0;
      for (const fragment of wanted) {
        const found = body.indexOf(fragment, at);
        if (found === -1) return false;
        at = found + fragment.length;
      }
      return true;
    })
    .map((segment) => segment.locator);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Finds `needle` in `haystack` treating every run of whitespace as equivalent,
 * returning the range in the HAYSTACK's coordinates. Deliberately simple: it
 * builds the whitespace-collapsed form of each and maps the hit back through an
 * index built while collapsing.
 */
function findWhitespaceRelaxed(haystack: string, needle: string): [number, number] | null {
  const collapsed: string[] = [];
  const originalIndex: number[] = [];
  let inWhitespace = false;
  for (let i = 0; i < haystack.length; i += 1) {
    const char = haystack[i]!;
    if (/\s/.test(char)) {
      if (!inWhitespace) {
        collapsed.push(' ');
        originalIndex.push(i);
        inWhitespace = true;
      }
      continue;
    }
    inWhitespace = false;
    collapsed.push(char);
    originalIndex.push(i);
  }
  const flatNeedle = needle.replace(/\s+/g, ' ');
  const at = collapsed.join('').indexOf(flatNeedle);
  if (at === -1) return null;
  const start = originalIndex[at]!;
  const lastIndex = at + flatNeedle.length - 1;
  const end = (originalIndex[lastIndex] ?? haystack.length - 1) + 1;
  return [start, end];
}
