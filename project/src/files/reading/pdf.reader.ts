import { PDFParse } from 'pdf-parse';
import { PDF_CONTENT_TYPE } from '@cogeto/shared';
import type { ReadSegment } from './locator';
import { normalizeWhitespaceWithMap } from './normalize';
import { readFailed } from './reader';
import type {
  DocumentReader,
  PageReadDetail,
  ReadInput,
  ReadReasonCode,
  ReadOutcome,
  ReadResult,
} from './reader';
import { newDocumentState, readPage } from './page-ladder';
import type { DocumentLadderState } from './page-ladder';
import type { ReadTier } from './ladder';

/**
 * PDF text, via `pdf-parse` (a thin wrapper over a maintained pdf.js exposing a
 * Buffer API — no ESM-interop friction with the CommonJS tsc build).
 *
 * MOVED, NOT REWRITTEN (V2.1 item 4.1, issue A2). The text this produces is
 * byte-identical to what `extractDocumentText` produced before the seam
 * existed: same parser, same per-page join, same normalization. `reading.spec.ts`
 * pins that against the reference implementation, because the golden set is
 * scored on this text and the eval cache is keyed on it.
 *
 * What is new is the page segment: the join is now performed with each page's
 * range recorded, and the normalizer reports where those ranges landed, so a
 * span can be resolved to a page number instead of to nothing.
 */
export class PdfReader implements DocumentReader {
  readonly format = 'pdf' as const;
  readonly contentTypes = [PDF_CONTENT_TYPE];
  readonly extensions = ['.pdf'];
  readonly detectable = true;
  readonly input = 'bytes' as const;
  readonly granularity = 'page' as const;

  async read({ bytes, ladder }: ReadInput): Promise<ReadResult> {
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    let pages: string[];
    try {
      const result = await parser.getText();
      // Per-page text (result.pages), NOT result.text — the latter interleaves
      // `-- N of M --` page markers that would pollute extraction.
      pages = result.pages.map((page) => page.text);
    } catch (error) {
      throw readFailed('could not parse PDF', {
        reasonCode: 'parse_failed',
        format: 'pdf',
        cause: error,
      });
    } finally {
      await parser.destroy().catch(() => undefined);
    }

    // The reading ladder (V2.1 item 4.1). WITHOUT it, every page keeps its own
    // text layer and the output is byte-identical to what this reader produced
    // before the ladder existed, which is the property the golden set and the
    // eval cache depend on. WITH it, a page whose text layer is unusable is
    // rendered, read by local OCR, and escalated to a model only if that fails.
    const state: DocumentLadderState | null = ladder ? newDocumentState(ladder.caps) : null;
    const climbed = ladder && state ? await climbLadder(bytes, pages, ladder, state) : null;
    // Without the ladder every page keeps its own text layer, which is what
    // makes this reader's output byte-identical to before the ladder existed.
    const detail: PageReadDetail[] = climbed?.detail ?? [];
    // No ladder ran → no tier is attached, and an absent tier already MEANS
    // the page's own text layer. That keeps a locator from a text-layer read
    // byte-identical to every locator produced before the ladder existed.
    const tiers: (ReadTier | null | undefined)[] = climbed?.tiers ?? pages.map(() => undefined);
    pages = climbed?.pages ?? pages;

    // The join, with each page's range in RAW coordinates.
    const separator = '\n\n';
    const ranges: Array<[number, number]> = [];
    let raw = '';
    pages.forEach((page, index) => {
      if (index > 0) raw += separator;
      const start = raw.length;
      raw += page;
      ranges.push([start, raw.length]);
    });

    const normalized = normalizeWhitespaceWithMap(raw);
    const segments: ReadSegment[] = [];
    ranges.forEach(([start, end], index) => {
      const from = normalized.map(start);
      const to = normalized.map(end);
      // A page whose text vanished in normalization (a blank scan page) gets no
      // segment: an empty range would claim provenance it cannot support.
      if (to > from) {
        const tier = tiers[index];
        segments.push({
          start: from,
          end: to,
          // The tier travels WITH the locator: a fact transcribed from a
          // photograph by a model is weaker evidence than one lifted from a
          // text layer, and the surfaces that render provenance must be able
          // to say which they are showing.
          locator: { kind: 'page', page: index + 1, ...(tier ? { tier } : {}) },
        });
      }
    });

    const unread = detail.filter((page) => page.tier === null);
    const needsVision = unread.filter(
      (page) =>
        page.reason === 'needs_vision_unavailable' || page.reason === 'needs_vision_cap_reached',
    );
    return {
      text: normalized.text,
      segments,
      report: {
        format: 'pdf',
        granularity: 'page',
        outcome: pdfOutcome(normalized.text, needsVision.length, detail.length),
        reasonCode: pdfReason(normalized.text, needsVision, unread),
        segments: segments.length,
        sheets: [],
        valuesUnavailable: 0,
        unavailableCells: [],
        ...(detail.length > 0 ? { pages: detail } : {}),
        ...(state ? { visionPagesUsed: state.visionPagesUsed } : {}),
      },
    };
  }
}

/**
 * A document is not one thing. Some pages read, some needed a capability this
 * instance does not have, and reporting either extreme as the whole truth is
 * the dishonesty this item exists to remove: `needs_vision` says pages are
 * missing even when others read fine.
 */
function pdfOutcome(text: string, needsVision: number, pagesInspected: number): ReadOutcome {
  if (needsVision > 0) return 'needs_vision';
  if (text.length === 0) return 'empty';
  return pagesInspected > 0 ? 'read' : 'read';
}

function pdfReason(
  text: string,
  needsVision: PageReadDetail[],
  unread: PageReadDetail[],
): ReadReasonCode | null {
  if (needsVision.length > 0) {
    // The cap and the missing capability are different problems with different
    // fixes: raise a number, or turn a capability on.
    return needsVision.some((page) => page.reason === 'needs_vision_cap_reached')
      ? 'vision_cap_reached'
      : 'vision_unavailable';
  }
  if (text.length > 0) return null;
  if (unread.some((page) => page.reason === 'vision_failed')) return 'vision_failed';
  // Nothing readable anywhere, and no capability would have changed that.
  return unread.length > 0 ? 'no_readable_text' : 'no_text';
}

/** Runs the ladder over every page, in order, carrying the document's caps. */
async function climbLadder(
  bytes: Buffer,
  pages: string[],
  ladder: NonNullable<ReadInput['ladder']>,
  state: DocumentLadderState,
): Promise<{ pages: string[]; tiers: (ReadTier | null)[]; detail: PageReadDetail[] }> {
  const read: string[] = [];
  const tiers: (ReadTier | null)[] = [];
  const detail: PageReadDetail[] = [];
  for (const [index, pageText] of pages.entries()) {
    const page = index + 1;
    const result = await readPage(bytes, page, pageText, ladder, state);
    read.push(result.text);
    const tier = result.outcome.read ? result.outcome.tier : null;
    tiers.push(tier);
    detail.push({ page, tier, reason: result.outcome.read ? null : result.outcome.reason });
  }
  return { pages: read, tiers, detail };
}
