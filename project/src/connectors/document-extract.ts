import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE } from '@cogeto/shared';

/**
 * Document → clean text for the ingestion pipeline (O1, session log: library
 * choice). PDF via `pdf-parse` (a thin, maintained wrapper over Mozilla's
 * pdf.js exposing a Buffer API — no ESM-interop friction with the CommonJS tsc
 * build, unlike importing pdfjs-dist directly); DOCX via `mammoth`. Both take
 * the bytes in memory — the worker already holds them.
 *
 * A parse failure is a PERMANENT error (corrupt/unsupported bytes): it must
 * surface as an error state and yield ZERO memories — never a fabricated one
 * (§B.3, scope §4.9). Callers let it propagate so the pipeline job dead-letters
 * and the file's status reads `error`.
 */

/** Thrown when bytes cannot be parsed — a permanent, do-not-fabricate failure. */
export class PermanentExtractionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PermanentExtractionError';
  }
}

/**
 * Sniffs the document type from magic bytes — defence in depth over the
 * client-declared content type, and the fallback when the stored object has
 * none. PDFs start with `%PDF`; DOCX is a ZIP (`PK\x03\x04`).
 */
export function sniffContentType(buffer: Buffer): string | null {
  if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === '%PDF') return PDF_CONTENT_TYPE;
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) return DOCX_CONTENT_TYPE;
  return null;
}

/**
 * Parse caps (FIX-2 QS-6): a wall-clock timeout around the parse and a cap on
 * the resulting (decompressed) text length. The 25 MB upload cap bounds only
 * COMPRESSED input, so a zip-bomb DOCX/PDF can still decompress to GBs of text;
 * these bound the parse time and reject over-long output as a PERMANENT error
 * (error state, zero downstream model calls) rather than OOM-ing the worker.
 */
export interface ExtractCaps {
  maxTextChars: number;
  timeoutSeconds: number;
}

const DEFAULT_EXTRACT_CAPS: ExtractCaps = { maxTextChars: 1_000_000, timeoutSeconds: 30 };

/**
 * Extracts text, routing on the resolved content type (declared type, else
 * sniffed). Unknown/unsupported types, parse failures, a parse that exceeds the
 * wall-clock timeout, and text over the length cap all throw
 * PermanentExtractionError (no fabricated memory, §B.3).
 */
export async function extractDocumentText(
  buffer: Buffer,
  declaredContentType: string | null,
  caps: ExtractCaps = DEFAULT_EXTRACT_CAPS,
): Promise<string> {
  const contentType = normalizeType(declaredContentType) ?? sniffContentType(buffer);
  const parse =
    contentType === PDF_CONTENT_TYPE
      ? () => extractPdf(buffer)
      : contentType === DOCX_CONTENT_TYPE
        ? () => extractDocx(buffer)
        : null;
  if (!parse) {
    throw new PermanentExtractionError(
      `unsupported document type '${declaredContentType ?? 'unknown'}'`,
    );
  }
  const text = await withParseTimeout(parse, caps.timeoutSeconds);
  if (text.length > caps.maxTextChars) {
    throw new PermanentExtractionError(
      `extracted text (${text.length} chars) exceeds the ${caps.maxTextChars}-char cap ` +
        `(possible decompression bomb) — QS-6`,
    );
  }
  return text;
}

/** Rejects with a PermanentExtractionError if the parse outruns the timeout. */
async function withParseTimeout(
  parse: () => Promise<string>,
  timeoutSeconds: number,
): Promise<string> {
  if (timeoutSeconds <= 0) return parse();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new PermanentExtractionError(`document parse exceeded ${timeoutSeconds}s — QS-6`)),
      timeoutSeconds * 1000,
    );
  });
  try {
    return await Promise.race([parse(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    // Join per-page text directly (result.pages), NOT result.text — the latter
    // interleaves `-- N of M --` page markers that would pollute extraction.
    return normalizeWhitespace(result.pages.map((page) => page.text).join('\n\n'));
  } catch (error) {
    throw new PermanentExtractionError('could not parse PDF', error);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return normalizeWhitespace(result.value);
  } catch (error) {
    throw new PermanentExtractionError('could not parse DOCX', error);
  }
}

function normalizeType(contentType: string | null): string | null {
  if (!contentType) return null;
  // Strip any `; charset=…` parameter and lowercase.
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  return base === PDF_CONTENT_TYPE || base === DOCX_CONTENT_TYPE ? base : null;
}

/** Collapses runs of blank lines / trailing spaces so chunking sees clean text. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
