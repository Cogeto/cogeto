import { crc32 } from 'node:zlib';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { describe, expect, it } from 'vitest';
import { DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE, XLSX_CONTENT_TYPE } from '@cogeto/shared';
import { makeDocx, makePdf, makeXlsx } from '../../testing/index';
import { locateSpan } from './locator';
import { normalizeWhitespaceReference } from './normalize';
import { PermanentExtractionError } from './reader';
import { readDocument, selectReader } from './registry';
import { sniffContentType, sniffFormat, zipEntryNames } from './sniff';

/**
 * The reader seam (V2.1 item 4.1, issue A).
 *
 * The load-bearing assertion in this file is the FIRST one: the PDF and DOCX
 * readers must produce exactly the text the pre-seam implementation produced.
 * The reference implementations below are that code, copied verbatim, so the
 * comparison is against what shipped rather than against a description of it.
 */

/** The pre-seam PDF extraction, verbatim. */
async function referencePdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return normalizeWhitespaceReference(result.pages.map((page) => page.text).join('\n\n'));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** The pre-seam DOCX extraction, verbatim. */
async function referenceDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return normalizeWhitespaceReference(result.value);
}

const PARAGRAPHS = [
  'Consulting Agreement, key obligations.',
  'Ana Kovač will deliver the CRM migration plan to Adriatic Foods by 15 August 2026.',
  'Adriatic Foods will pay each invoice within 15 days of receipt.',
];

describe('PDF and DOCX behind the seam produce identical text', () => {
  it('DOCX: reader output equals the pre-seam implementation', async () => {
    const docx = await makeDocx(PARAGRAPHS);
    const result = await readDocument(docx, { declaredContentType: DOCX_CONTENT_TYPE });
    expect(result.text).toBe(await referenceDocxText(docx));
  });

  it('PDF: reader output equals the pre-seam implementation', async () => {
    const pdf = makePdf('Adriatic Foods will pay each invoice within 15 days of receipt.');
    const result = await readDocument(pdf, { declaredContentType: PDF_CONTENT_TYPE });
    expect(result.text).toBe(await referencePdfText(pdf));
  });

  it('DOCX: every paragraph is separately locatable', async () => {
    const docx = await makeDocx(PARAGRAPHS);
    const result = await readDocument(docx, { declaredContentType: DOCX_CONTENT_TYPE });
    expect(result.report.granularity).toBe('paragraph');
    expect(result.segments).toHaveLength(PARAGRAPHS.length);
    expect(locateSpan(result.text, result.segments, 'pay each invoice within 15 days')).toEqual([
      { kind: 'paragraph', paragraph: 3 },
    ]);
  });

  it('PDF: a span resolves to its page number', async () => {
    const pdf = makePdf('Adriatic Foods will pay each invoice within 15 days of receipt.');
    const result = await readDocument(pdf, { declaredContentType: PDF_CONTENT_TYPE });
    expect(result.report.granularity).toBe('page');
    expect(locateSpan(result.text, result.segments, 'pay each invoice')).toEqual([
      { kind: 'page', page: 1 },
    ]);
  });

  it('a span nobody can find resolves to nothing, never to a guess', async () => {
    const docx = await makeDocx(PARAGRAPHS);
    const result = await readDocument(docx, { declaredContentType: DOCX_CONTENT_TYPE });
    expect(locateSpan(result.text, result.segments, 'a sentence from another document')).toEqual(
      [],
    );
  });

  it('resolves a span whose whitespace the model re-wrapped', async () => {
    const docx = await makeDocx(PARAGRAPHS);
    const result = await readDocument(docx, { declaredContentType: DOCX_CONTENT_TYPE });
    expect(
      locateSpan(result.text, result.segments, 'pay each\n  invoice   within 15 days'),
    ).toEqual([{ kind: 'paragraph', paragraph: 3 }]);
  });
});

describe('selection is by detected type, with the extension as a hint', () => {
  it('distinguishes DOCX from XLSX inside the ZIP container', async () => {
    const docx = await makeDocx(['hello']);
    const xlsx = await makeXlsx([{ name: 'Sheet1', rows: [['Name', 'Amount']] }]);
    expect(sniffFormat(docx)).toBe('docx');
    expect(sniffFormat(xlsx)).toBe('xlsx');
    expect(sniffContentType(xlsx)).toBe(XLSX_CONTENT_TYPE);
    expect(sniffContentType(docx)).toBe(DOCX_CONTENT_TYPE);
  });

  it('reads a spreadsheet that was uploaded labelled as a document', async () => {
    const xlsx = await makeXlsx([
      {
        name: 'Orders',
        rows: [
          ['Customer', 'Amount'],
          ['Adriatic Foods', 12500],
        ],
      },
    ]);
    // The bytes outrank the label: this is read as a workbook, not refused.
    const result = await readDocument(xlsx, {
      declaredContentType: DOCX_CONTENT_TYPE,
      filename: 'orders.docx',
    });
    expect(result.report.format).toBe('xlsx');
    expect(result.text).toContain('Customer: Adriatic Foods');
  });

  it('refuses a file whose label claims a format its bytes are not', async () => {
    const notAPdf = Buffer.from('Customer,Amount\nAdriatic Foods,12500\n', 'utf8');
    const error = await readDocument(notAPdf, {
      declaredContentType: PDF_CONTENT_TYPE,
      filename: 'orders.pdf',
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PermanentExtractionError);
    expect((error as PermanentExtractionError).outcome).toBe('unsupported_format');
  });

  it('names the legacy Office format instead of calling it a read failure', async () => {
    const ole2 = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ]);
    const error = await readDocument(ole2, { filename: 'budget.xls' }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(PermanentExtractionError);
    expect((error as PermanentExtractionError).outcome).toBe('unsupported_format');
    expect((error as PermanentExtractionError).reasonCode).toBe('legacy_office_format');
  });

  it('does not sniff an arbitrary ZIP as a document', () => {
    // A store-only ZIP holding one unrelated entry: recognisably a ZIP, and
    // recognisably not an OOXML package. Before the seam this sniffed as DOCX.
    const zip = makeMinimalZip('notes.txt', 'hello');
    expect(zipEntryNames(zip)).toEqual(['notes.txt']);
    expect(sniffFormat(zip)).toBeNull();
    expect(sniffContentType(zip)).toBeNull();
  });

  it('selects CSV from the extension when the bytes say nothing', () => {
    const csv = Buffer.from('Customer;Amount\nAdriatic Foods;12500\n', 'utf8');
    expect(selectReader(csv, null, 'orders.csv').format).toBe('csv');
    expect(selectReader(csv, 'text/csv', null).format).toBe('csv');
  });

  it('refuses an unknown type outright', async () => {
    const error = await readDocument(Buffer.from('not a document'), {
      declaredContentType: 'application/x-unknown',
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PermanentExtractionError);
    expect((error as PermanentExtractionError).reasonCode).toBe('unsupported_type');
  });
});

describe('failures are classified, and the caps still bite', () => {
  it('a corrupt file of a supported format is a read failure, not an unsupported one', async () => {
    // A truncated OOXML package: the sniff finds the entry name, the parser
    // cannot open it. That is "we should have been able to read this".
    const broken = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('word/document.xml', 'latin1'),
      Buffer.alloc(32),
    ]);
    const error = await readDocument(broken, { declaredContentType: DOCX_CONTENT_TYPE }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(PermanentExtractionError);
    expect((error as PermanentExtractionError).outcome).toBe('read_failed');
    expect((error as PermanentExtractionError).reasonCode).toBe('parse_failed');
  });

  it('rejects text over the length cap as a decompression-bomb guard', async () => {
    const docx = await makeDocx(['word '.repeat(2000)]);
    await expect(
      readDocument(docx, { declaredContentType: DOCX_CONTENT_TYPE, caps: { maxTextChars: 100 } }),
    ).rejects.toThrow(/exceeds the 100-char cap/);
  });

  it('reports an unreadable document as empty rather than failing', async () => {
    const blank = await makeDocx(['   ']);
    const result = await readDocument(blank, { declaredContentType: DOCX_CONTENT_TYPE });
    expect(result.text).toBe('');
    expect(result.report.outcome).toBe('empty');
    expect(result.report.reasonCode).toBe('no_text');
  });
});

/** A store-only (method 0) single-entry ZIP. */
function makeMinimalZip(name: string, content: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = Buffer.from(content, 'utf8');
  const crc = crc32(data) >>> 0;
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(data.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(data.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42);
  const central = Buffer.concat([cdh, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(lfh.length + nameBuf.length + data.length, 16);
  return Buffer.concat([lfh, nameBuf, data, central, eocd]);
}
