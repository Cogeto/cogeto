import mammoth from 'mammoth';
import { DOCX_CONTENT_TYPE } from '@cogeto/shared';
import type { ReadSegment } from './locator';
import { normalizeWhitespaceWithMap } from './normalize';
import { readFailed } from './reader';
import type { DocumentReader, ReadInput, ReadResult } from './reader';

/**
 * DOCX text, via `mammoth`.
 *
 * MOVED, NOT REWRITTEN (V2.1 item 4.1, issue A2): same `extractRawText` call,
 * same normalization, byte-identical output, pinned by `reading.spec.ts`.
 *
 * The paragraph segments are derived from the text mammoth already returned
 * (it emits one line per paragraph) rather than from a different traversal of
 * the document, precisely so the text cannot drift. A paragraph index is a
 * weaker locator than a page number, and it is the honest one for a flowed
 * document: DOCX has no pages until something lays it out.
 */
export class DocxReader implements DocumentReader {
  readonly format = 'docx' as const;
  readonly contentTypes = [DOCX_CONTENT_TYPE];
  readonly extensions = ['.docx'];
  readonly detectable = true;
  readonly input = 'bytes' as const;
  readonly granularity = 'paragraph' as const;

  async read({ bytes }: ReadInput): Promise<ReadResult> {
    let raw: string;
    try {
      const result = await mammoth.extractRawText({ buffer: bytes });
      raw = result.value;
    } catch (error) {
      throw readFailed('could not parse DOCX', {
        reasonCode: 'parse_failed',
        format: 'docx',
        cause: error,
      });
    }

    const normalized = normalizeWhitespaceWithMap(raw);
    const segments: ReadSegment[] = [];
    let paragraph = 0;
    let at = 0;
    // Walk the NORMALIZED text line by line: after normalization a paragraph is
    // exactly a non-empty line, and blank lines are separators.
    for (const line of normalized.text.split('\n')) {
      if (line.trim().length > 0) {
        paragraph += 1;
        segments.push({
          start: at,
          end: at + line.length,
          locator: { kind: 'paragraph', paragraph },
        });
      }
      at += line.length + 1; // + the newline that split removed
    }

    return {
      text: normalized.text,
      segments,
      report: {
        format: 'docx',
        granularity: 'paragraph',
        outcome: normalized.text.length === 0 ? 'empty' : 'read',
        reasonCode: normalized.text.length === 0 ? 'no_text' : null,
        segments: segments.length,
        sheets: [],
        valuesUnavailable: 0,
        unavailableCells: [],
      },
    };
  }
}
