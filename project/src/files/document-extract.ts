import type { ParseCaps } from '../infrastructure/index';
import { readDocument } from './reading/registry';

/**
 * Document → clean text for the ingestion pipeline.
 *
 * Since V2.1 item 4.1 this is a THIN ADAPTER over the reader seam
 * (`./reading/`), kept because two callers want exactly this and nothing more:
 * the fetched-PDF path in `research` and the email intake's attachment sniff.
 * They pass bytes and get text; they have no use for segments or a read report,
 * and inventing one for them would be churn.
 *
 * Everything the old implementation guaranteed still holds, and is now enforced
 * in one place for every format: a parse failure is a PERMANENT error (corrupt
 * or unsupported bytes) that must surface as an error state and yield ZERO
 * memories, never a fabricated one (spec §2, scope §4.9). Callers let it
 * propagate so the pipeline job dead-letters and the file's status reads
 * `error`.
 */

export { PermanentExtractionError } from './reading/reader';
export { sniffContentType } from './reading/sniff';

/**
 * The subset of the parse caps a text-only caller cares about. A superset (the
 * full {@link ParseCaps}) is accepted, which is what the file source reader
 * passes.
 */
export type ExtractCaps = Partial<ParseCaps>;

/**
 * Extracts text, routing on the resolved content type (the magic bytes first,
 * the declared type and the filename as hints). Unknown or unsupported types,
 * parse failures, a parse that outruns the wall-clock timeout, and text over
 * the length cap all throw `PermanentExtractionError`.
 */
export async function extractDocumentText(
  buffer: Buffer,
  declaredContentType: string | null,
  caps: ExtractCaps = {},
  filename: string | null = null,
): Promise<string> {
  const result = await readDocument(buffer, { declaredContentType, filename, caps });
  return result.text;
}
