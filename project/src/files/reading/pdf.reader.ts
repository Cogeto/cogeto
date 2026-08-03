import { PDFParse } from 'pdf-parse';
import { PDF_CONTENT_TYPE } from '@cogeto/shared';
import type { ReadSegment } from './locator';
import { normalizeWhitespaceWithMap } from './normalize';
import { readFailed } from './reader';
import type { DocumentReader, ReadInput, ReadResult } from './reader';

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

  async read({ bytes }: ReadInput): Promise<ReadResult> {
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
      if (to > from)
        segments.push({ start: from, end: to, locator: { kind: 'page', page: index + 1 } });
    });

    return {
      text: normalized.text,
      segments,
      report: {
        format: 'pdf',
        granularity: 'page',
        outcome: normalized.text.length === 0 ? 'empty' : 'read',
        // A PDF with no extractable text is the scanned-document case the OCR
        // half of 4.1 picks up. Recording it now is what makes "done, zero
        // facts" stop being silent.
        reasonCode: normalized.text.length === 0 ? 'no_text' : null,
        segments: segments.length,
        sheets: [],
        valuesUnavailable: 0,
        unavailableCells: [],
      },
    };
  }
}
