import { MARKDOWN_CONTENT_TYPE, PLAIN_TEXT_CONTENT_TYPE } from '@cogeto/shared';
import { decodeText } from './csv.reader';
import type { ReadSegment } from './locator';
import { normalizeWhitespaceWithMap } from './normalize';
import type { DocumentReader, ReadInput, ReadResult } from './reader';

/**
 * Plain text and Markdown (V2.5 item 8.2): a converted Confluence page uploads
 * as `text/markdown`, and `.txt` notes ride the same reader.
 *
 * Markdown is NOT parsed. A heading or a list item stays its literal line:
 * this reader's job is text plus paragraph provenance, not rendering, and a
 * rendered form would break span verification against what was stored.
 *
 * Decoding is the CSV reader's ladder (BOM, strict UTF-8, then the configured
 * fallback encoding), imported rather than duplicated: nothing in
 * signature-less bytes says how they encode text, and the answer must not
 * depend on which of the two text readers got the file. The encoding used is
 * on the read report, same as CSV.
 *
 * Paragraphs are blank-line separated blocks of the NORMALIZED text, so a
 * hard-wrapped paragraph is ONE segment. The locator is the shape DOCX emits:
 * `paragraph`, 1-based, counting non-empty blocks in order.
 */
export class TextReader implements DocumentReader {
  readonly format = 'text' as const;
  readonly contentTypes = [MARKDOWN_CONTENT_TYPE, PLAIN_TEXT_CONTENT_TYPE];
  readonly extensions = ['.md', '.markdown', '.txt'];
  readonly detectable = false;
  readonly input = 'bytes' as const;
  readonly granularity = 'paragraph' as const;

  async read({ bytes, caps }: ReadInput): Promise<ReadResult> {
    const { text: decoded, encoding } = decodeText(bytes, caps.csvFallbackEncoding);
    const normalized = normalizeWhitespaceWithMap(decoded).text;
    const { text, truncated } = capAtParagraphs(normalized, caps.maxTextChars);

    const segments: ReadSegment[] = [];
    let paragraph = 0;
    let at = 0;
    // After normalization a blank-line run is exactly '\n\n', so the blocks
    // between those runs are the paragraphs; numbering mirrors the DOCX
    // reader's (1-based, non-empty blocks only).
    for (const block of text.split('\n\n')) {
      if (block.trim().length > 0) {
        paragraph += 1;
        segments.push({
          start: at,
          end: at + block.length,
          locator: { kind: 'paragraph', paragraph },
        });
      }
      at += block.length + 2;
    }

    return {
      text,
      segments,
      report: {
        format: 'text',
        granularity: 'paragraph',
        outcome: text.length === 0 ? 'empty' : truncated ? 'truncated' : 'read',
        reasonCode: text.length === 0 ? 'no_text' : truncated ? 'text_over_cap' : null,
        segments: segments.length,
        sheets: [],
        valuesUnavailable: 0,
        unavailableCells: [],
        encoding,
      },
    };
  }
}

/**
 * Cuts to whole paragraphs under the char cap, so a truncated read never ends
 * mid-sentence while claiming to be complete. A first paragraph that alone
 * exceeds the cap is hard-cut instead of dropped, because some text is the
 * honest maximum. Truncation is reported, never written into the text.
 */
function capAtParagraphs(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const kept: string[] = [];
  let length = 0;
  for (const block of text.split('\n\n')) {
    const next = length === 0 ? block.length : length + 2 + block.length;
    if (next > maxChars) break;
    kept.push(block);
    length = next;
  }
  if (kept.length === 0) return { text: text.slice(0, maxChars), truncated: true };
  return { text: kept.join('\n\n'), truncated: true };
}
