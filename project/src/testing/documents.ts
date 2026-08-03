import { crc32 } from 'node:zlib';
import ExcelJS from 'exceljs';

/**
 * Test-only document fixtures: real PDF, DOCX and XLSX bytes so pdf-parse,
 * mammoth and exceljs run for real in the pipeline and reading tests (a stubbed
 * extractor would prove nothing). Any spec may use them, in any module.
 */

/** A cell as a fixture declares it. `formula` with no `result` is an uncached
 * value — the case the reader must report as unavailable rather than guess. */
export type XlsxCell =
  string | number | boolean | Date | null | { formula: string; result?: string | number };

export interface XlsxSheetFixture {
  name: string;
  rows: XlsxCell[][];
  /** A1-style ranges to merge, e.g. `['A1:D1']`. */
  merges?: string[];
}

/** A real .xlsx workbook. Written by the same library the reader reads with,
 * which is the point: the fixture exercises the container, not a mock of it. */
export async function makeXlsx(sheets: XlsxSheetFixture[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    sheet.rows.forEach((cells, rowIndex) => {
      cells.forEach((value, columnIndex) => {
        if (value === null) return;
        worksheet.getRow(rowIndex + 1).getCell(columnIndex + 1).value = value as never;
      });
    });
    for (const merge of sheet.merges ?? []) worksheet.mergeCells(merge);
  }
  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written);
}

/** A minimal single-page PDF whose text `pdf-parse` can extract. */
export function makePdf(text: string): Buffer {
  const esc = text.replace(/([\\()])/g, '\\$1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  ];
  const stream = `BT /F1 18 Tf 72 700 Td (${esc}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => (pdf += `${String(off).padStart(10, '0')} 00000 n \n`));
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/** A store-only (method 0) ZIP — enough of a.docx for mammoth to read. */
export function makeDocx(paras: string[]): Buffer {
  const body = paras
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ],
  ];
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, contentStr] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(contentStr, 'utf8');
    const crc = crc32(data) >>> 0;
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lfh, nameBuf, data);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdh, nameBuf]));
    offset += lfh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/**
 * A PDF that is a PICTURE of a page, which is what a scan actually is (V2.1
 * item 4.1).
 *
 * Built by rendering a text PDF to a JPEG and wrapping that JPEG back into a
 * PDF as a full-page image, so the result has real pixels of real text and no
 * text layer at all: exactly the file that today passes through as
 * done-with-zero-facts. Needs `pdftoppm`, so callers gate on it.
 *
 * `junkTextLayer` adds the other half of the real-world case: a scan that
 * carries a token text layer of ligature soup, which a reader that checks only
 * for the PRESENCE of text would take and report as read. It is drawn in
 * INVISIBLE render mode, exactly as a real scanner's search layer is, so OCR
 * cannot see it and only the text layer carries it.
 *
 * Rendering is the CALLER's job, passed in: this module is documented as pure
 * and importable from any spec, and reaching into a module's internals to run
 * poppler would break that (and the boundary rules with it).
 */
export async function makeScannedPdf(
  text: string,
  options: {
    /** Renders a PDF page to a JPEG. The reading module's rasterizer, supplied
     * by the spec so this helper keeps no dependencies of its own. */
    renderJpeg: (pdf: Buffer) => Promise<Buffer>;
    junkTextLayer?: string;
  },
): Promise<Buffer> {
  const jpeg = await options.renderJpeg(makePdf(text));
  if (jpeg.length === 0) throw new Error('could not render the scan fixture');
  return wrapJpegInPdf(jpeg, options.junkTextLayer);
}

/** A full-page JPEG as a PDF page, with an optional text layer over it. */
function wrapJpegInPdf(jpeg: Buffer, junkTextLayer?: string): Buffer {
  const { width, height } = jpegSize(jpeg);
  // Letter-ish at 72 units per inch, keeping the image's aspect ratio.
  const pageWidth = 612;
  const pageHeight = Math.round((height / width) * pageWidth);
  const drawImage = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;
  const drawText = junkTextLayer
    ? `\nBT 3 Tr /F1 9 Tf 24 ${pageHeight - 24} Td (${junkTextLayer.replace(/([\\()])/g, '\\$1')}) Tj ET`
    : '';
  const content = `${drawImage}${drawText}`;

  const objects: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /XObject << /Im0 5 0 R >> /Font << /F1 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        'latin1',
      ),
      jpeg,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const head = Buffer.from(`${index + 1} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    const bodyBuffer = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
    const chunk = Buffer.concat([head, bodyBuffer, tail]);
    parts.push(chunk);
    offset += chunk.length;
  });
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) xref += `${String(at).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** Reads a JPEG's dimensions from its SOF marker. */
function jpegSize(jpeg: Buffer): { width: number; height: number } {
  let at = 2;
  while (at < jpeg.length - 9) {
    if (jpeg[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = jpeg[at + 1]!;
    // SOF0..SOF15, excluding the non-frame markers in the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    }
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  throw new Error('could not read the JPEG size');
}
