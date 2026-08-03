import {
  CSV_CONTENT_TYPE,
  DOCX_CONTENT_TYPE,
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
} from '@cogeto/shared';
import type { DocumentFormat } from './reader';

/**
 * Magic-byte detection (V2.1 item 4.1, issue A1).
 *
 * Selection is by DETECTED type with the extension as a hint, never by
 * extension alone, so a mislabelled upload is routed by what it actually is or
 * refused. Two things made that harder than a four-byte compare:
 *
 * - **DOCX and XLSX are both ZIP containers.** Stopping at `PK` (which is what
 *   this file did before spreadsheets existed) would route every spreadsheet to
 *   the DOCX reader. The container's entry names are what distinguish them, so
 *   the sniff walks the ZIP central directory.
 * - **Some formats are recognisable but unsupported.** A legacy `.xls` or
 *   `.doc` is an OLE2 compound file, and telling the user "Cogeto does not read
 *   the pre-2007 Excel format" is a different and more useful answer than
 *   "unsupported file type".
 *
 * Text formats (CSV) have no magic bytes by definition. They are never
 * *sniffed into*; they are selected from the declared type or the extension,
 * and the sniff's job for them is the negative one: proving the bytes are not
 * secretly a PDF or a workbook (see `sniffFormat` returning non-null).
 */

/** What the bytes are, when the bytes say so. */
export type SniffedFormat = DocumentFormat | 'ole2';

const OOXML_ENTRY_MARKERS: ReadonlyArray<{ entry: string; format: DocumentFormat }> = [
  { entry: 'word/document.xml', format: 'docx' },
  { entry: 'xl/workbook.xml', format: 'xlsx' },
];

/** Signature of a ZIP local file header. */
const ZIP_LOCAL_HEADER = 0x04034b50;
/** Signature of a ZIP central directory file header. */
const ZIP_CENTRAL_HEADER = 0x02014b50;
/** Signature of the End Of Central Directory record. */
const ZIP_EOCD = 0x06054b50;
/** The EOCD lives in the last 64 KiB + 22 bytes of the file, by specification. */
const EOCD_SEARCH_WINDOW = 66 * 1024;

/**
 * The format the bytes themselves declare, or null when they declare nothing
 * (any text format, and anything unrecognised).
 */
export function sniffFormat(buffer: Buffer): SniffedFormat | null {
  if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === '%PDF') return 'pdf';
  // OLE2 compound file: legacy .doc/.xls/.ppt.
  if (
    buffer.length >= 8 &&
    buffer.readUInt32BE(0) === 0xd0cf11e0 &&
    buffer.readUInt32BE(4) === 0xa1b11ae1
  ) {
    return 'ole2';
  }
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZIP_LOCAL_HEADER) {
    return sniffOoxml(buffer);
  }
  return null;
}

/**
 * Back-compatible content-type sniff: the same function name and contract the
 * upload boundary and the email intake have always called, now able to name a
 * workbook.
 *
 * The one behaviour change: a ZIP that is NOT a recognised OOXML package used
 * to sniff as DOCX and now sniffs as nothing. That is the point of the check.
 * It only ever produced a file that parsed to an error later.
 */
export function sniffContentType(buffer: Buffer): string | null {
  const format = sniffFormat(buffer);
  switch (format) {
    case 'pdf':
      return PDF_CONTENT_TYPE;
    case 'docx':
      return DOCX_CONTENT_TYPE;
    case 'xlsx':
      return XLSX_CONTENT_TYPE;
    case 'csv':
      return CSV_CONTENT_TYPE;
    // An OLE2 file is recognised, not supported: naming a content type for it
    // would let it through the upload allowlist as if it were readable.
    case 'ole2':
    case null:
      return null;
  }
}

/** Which OOXML package this ZIP is, by its entry names. */
function sniffOoxml(buffer: Buffer): DocumentFormat | null {
  const entries = zipEntryNames(buffer);
  if (entries) {
    for (const { entry, format } of OOXML_ENTRY_MARKERS) {
      if (entries.some((name) => name === entry || name.startsWith(`${entry}.`))) return format;
    }
    // A ZIP whose directory we read and which holds neither part is not an
    // OOXML document we know. Say so rather than guess.
    return null;
  }
  // Unreadable directory (ZIP64, or a truncated upload): fall back to scanning
  // for the entry name, which appears uncompressed in every local file header.
  for (const { entry, format } of OOXML_ENTRY_MARKERS) {
    if (buffer.includes(entry, 0, 'latin1')) return format;
  }
  return null;
}

/**
 * The entry names in the ZIP central directory, or null when it cannot be read
 * (no EOCD in the window, a ZIP64 locator, or a malformed directory). Reads
 * names only: nothing is inflated, so a zip bomb costs nothing here.
 */
export function zipEntryNames(buffer: Buffer): string[] | null {
  const eocd = findEocd(buffer);
  if (eocd === null) return null;
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  // ZIP64 marks these fields as 0xFFFF/0xFFFFFFFF and puts the real values in a
  // separate record. Not worth parsing for a type sniff: fall back to the scan.
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) return null;
  if (directoryOffset >= buffer.length) return null;

  const names: string[] = [];
  let at = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (at + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(at) !== ZIP_CENTRAL_HEADER) return null;
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const nameAt = at + 46;
    if (nameAt + nameLength > buffer.length) return null;
    names.push(buffer.toString('utf8', nameAt, nameAt + nameLength));
    at = nameAt + nameLength + extraLength + commentLength;
  }
  return names;
}

/** Offset of the End Of Central Directory record, searched from the end. */
function findEocd(buffer: Buffer): number | null {
  const from = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW);
  for (let at = buffer.length - 22; at >= from; at -= 1) {
    if (buffer.readUInt32LE(at) === ZIP_EOCD) return at;
  }
  return null;
}
