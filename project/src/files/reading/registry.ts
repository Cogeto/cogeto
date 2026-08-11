import { Readable } from 'node:stream';
import { PLAIN_TEXT_CONTENT_TYPE } from '@cogeto/shared';
import { DEFAULT_PARSE_CAPS } from '../../infrastructure/index';
import type { ParseCaps } from '../../infrastructure/index';
import { CsvReader } from './csv.reader';
import { ImageReader } from './image.reader';
import type { PageLadderServices } from './page-ladder';
import { DocxReader } from './docx.reader';
import { PdfReader } from './pdf.reader';
import { readFailed, unsupportedFormat } from './reader';
import type { DocumentFormat, DocumentReader, ReadResult } from './reader';
import { sniffFormat } from './sniff';
import { TextReader } from './text.reader';
import { XlsxReader } from './xlsx.reader';

/**
 * The reader registry (V2.1 item 4.1, issue A1): the one place that decides
 * WHICH reader gets a document, and the one place that applies the caps and
 * classifies a failure. A new format is an entry in this array plus its reader;
 * there is no switch to extend, which is the whole point of the seam, and the
 * OCR and vision tiers land here as two more entries.
 */
export const DOCUMENT_READERS: readonly DocumentReader[] = [
  new PdfReader(),
  new DocxReader(),
  new XlsxReader(),
  new CsvReader(),
  // Plain text and Markdown (V2.5 item 8.2): a converted Confluence page
  // uploads as Markdown.
  new TextReader(),
  // Standalone images (V2.1 item 4.1): a photograph, a screenshot or an
  // exported diagram is a document too.
  new ImageReader(),
];

export interface ReadOptions {
  /** The content type the caller declared. A hint; the bytes outrank it. */
  declaredContentType?: string | null;
  /** The uploader's filename. A hint of last resort; the bytes outrank it. */
  filename?: string | null;
  /** Parse caps; the generous defaults fill in what a caller omits. */
  caps?: Partial<ParseCaps>;
  /** The registry to select from. Tests substitute; production never does. */
  readers?: readonly DocumentReader[];
  /** The reading ladder's tiers (V2.1 item 4.1); absent → text layers only. */
  ladder?: PageLadderServices;
}

/**
 * Reads a document: selects the reader, runs it under the wall-clock timeout,
 * and enforces the decompressed-text cap.
 *
 * **Selection order, and why.** The magic bytes decide first, always. A file
 * whose bytes name a format Cogeto reads is read as that format even when the
 * upload declared something else, because a mislabelled upload is far more
 * often a browser guessing than an attempt to smuggle anything, and reading it
 * correctly is the useful answer. Only when the bytes name NOTHING do the
 * declared content type and then the extension get a say, and even then a
 * reader for a byte-detectable format (PDF, DOCX, XLSX) refuses the file: we
 * know what those look like, and these bytes are not it. That refusal is
 * `unsupported_format`, not `read_failed` — the difference the source drawer
 * shows the user.
 */
export async function readDocument(bytes: Buffer, options: ReadOptions = {}): Promise<ReadResult> {
  const caps: ParseCaps = { ...DEFAULT_PARSE_CAPS, ...options.caps };
  const readers = options.readers ?? DOCUMENT_READERS;
  const declaredContentType = normalizeContentType(options.declaredContentType ?? null);
  const filename = options.filename ?? null;
  const reader = selectReader(bytes, declaredContentType, filename, readers);

  const result = await withTimeout(
    () =>
      reader.read({
        bytes,
        stream: () => Readable.from(bytes),
        filename,
        declaredContentType,
        caps,
        ...(options.ladder ? { ladder: options.ladder } : {}),
      }),
    caps.timeoutSeconds,
    reader.format,
  );

  if (result.text.length > caps.maxTextChars) {
    // The upload byte cap bounds COMPRESSED input only, so a decompression bomb
    // is still possible here. Refuse rather than hand the pipeline gigabytes.
    throw readFailed(
      `extracted text (${result.text.length} chars) exceeds the ${caps.maxTextChars}-char cap ` +
        `(possible decompression bomb)`,
      { reasonCode: 'text_over_cap', format: reader.format },
    );
  }
  return result;
}

/** The reader for these bytes, or a PermanentExtractionError explaining why not. */
export function selectReader(
  bytes: Buffer,
  declaredContentType: string | null,
  filename: string | null,
  readers: readonly DocumentReader[] = DOCUMENT_READERS,
): DocumentReader {
  const sniffed = sniffFormat(bytes);
  if (sniffed === 'ole2') {
    throw unsupportedFormat(
      'legacy Office format (pre-2007 .doc/.xls); save it as .docx or .xlsx',
      'legacy_office_format',
    );
  }
  if (sniffed !== null) {
    const byBytes = readers.find((candidate) => candidate.format === sniffed);
    if (byBytes) return byBytes;
  }

  const hinted =
    (declaredContentType
      ? readerForDeclaredType(declaredContentType, filename, readers)
      : undefined) ?? readerForExtension(filename, readers);

  if (!hinted) {
    throw unsupportedFormat(`unsupported document type '${declaredContentType ?? 'unknown'}'`);
  }
  if (hinted.detectable) {
    // The hint names a format whose bytes are recognisable, and these bytes are
    // not it. Trusting the label here is exactly the mislabelled-upload case.
    throw unsupportedFormat(
      `the file is labelled '${declaredContentType ?? hinted.format}' but its bytes are not ${hinted.format.toUpperCase()}`,
    );
  }
  return hinted;
}

/**
 * The reader claiming a declared content type, with one exception:
 * `text/plain` is the label browsers put on ANY textual file, so for it the
 * extension speaks first. That keeps the CSV alias behaviour exactly as it
 * was (a `.csv` or `.tsv` declared `text/plain` still routes to the CSV
 * reader, and a `.pdf` name still hits the detectable-format refusal below),
 * while a `.txt` or `.md` lands on the text reader that claims it anyway.
 */
function readerForDeclaredType(
  declaredContentType: string,
  filename: string | null,
  readers: readonly DocumentReader[],
): DocumentReader | undefined {
  if (declaredContentType === PLAIN_TEXT_CONTENT_TYPE) {
    const byExtension = readerForExtension(filename, readers);
    if (byExtension) return byExtension;
  }
  return readers.find((candidate) => candidate.contentTypes.includes(declaredContentType));
}

function readerForExtension(
  filename: string | null,
  readers: readonly DocumentReader[],
): DocumentReader | undefined {
  if (!filename) return undefined;
  const lower = filename.toLowerCase();
  return readers.find((candidate) =>
    candidate.extensions.some((extension) => lower.endsWith(extension)),
  );
}

/** Strips any `; charset=…` parameter and lowercases. */
export function normalizeContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  return base === '' ? null : base;
}

/** Rejects with a permanent failure if the read outruns the timeout. */
async function withTimeout<T>(
  run: () => Promise<T>,
  timeoutSeconds: number,
  format: DocumentFormat,
): Promise<T> {
  if (timeoutSeconds <= 0) return run();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          readFailed(`document parse exceeded ${timeoutSeconds}s`, {
            reasonCode: 'parse_timeout',
            format,
          }),
        ),
      timeoutSeconds * 1000,
    );
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
