import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { ParsedFont } from './ttf';

/**
 * A minimal, deterministic PDF writer (V2.3 item 6.2) — pages of raw content
 * operators plus embedded CIDFontType2 fonts (Identity-H, full font file,
 * ToUnicode CMap so quoted evidence survives copy and paste). Dependency-free
 * on purpose; `node:zlib` provides FlateDecode.
 *
 * Determinism is a feature: object order is creation order, the document ID
 * derives from the caller's seed, and the creation date is the caller's, so
 * two runs over the same data produce comparable documents.
 */

export interface PdfWriterOptions {
  width: number;
  height: number;
  title: string;
  /** Stamped as CreationDate/ModDate; the run's timestamp, never wall clock. */
  creationDate: Date;
  /** Seeds the trailer /ID, so identical inputs give identical files. */
  idSeed: string;
  language: string;
}

export class PdfFont {
  readonly used = new Map<number, number>();

  constructor(
    readonly resourceName: string,
    readonly parsed: ParsedFont,
  ) {
    // Glyph 0 (.notdef) renders for unmapped code points; space stays mapped.
    this.used.set(0, 0xfffd);
  }

  /** Text → glyph ids, recording usage for /W and ToUnicode. */
  encode(text: string): { hex: string; width: number } {
    let hex = '';
    let width = 0;
    for (const ch of text) {
      const codePoint = ch.codePointAt(0)!;
      const gid = this.parsed.glyphFor(codePoint);
      if (!this.used.has(gid) || gid === 0) {
        if (gid !== 0) this.used.set(gid, codePoint);
      }
      hex += gid.toString(16).padStart(4, '0');
      width += this.parsed.advanceOf(gid);
    }
    return { hex, width };
  }

  /** Width of `text` at `size` points. */
  widthOf(text: string, size: number): number {
    let units = 0;
    for (const ch of text) {
      units += this.parsed.advanceOf(this.parsed.glyphFor(ch.codePointAt(0)!));
    }
    return (units / this.parsed.unitsPerEm) * size;
  }
}

export class PdfPage {
  readonly ops: string[] = [];

  op(operators: string): void {
    this.ops.push(operators);
  }
}

export class PdfWriter {
  private readonly fonts: PdfFont[] = [];
  private readonly pages: PdfPage[] = [];

  constructor(private readonly options: PdfWriterOptions) {}

  registerFont(parsed: ParsedFont): PdfFont {
    const font = new PdfFont(`F${this.fonts.length + 1}`, parsed);
    this.fonts.push(font);
    return font;
  }

  addPage(): PdfPage {
    const page = new PdfPage();
    this.pages.push(page);
    return page;
  }

  /** Move a run of pages to a new position — how the TOC, composed last so
   * every section's page is known, lands right after the cover. */
  movePages(from: number, count: number, to: number): void {
    const moved = this.pages.splice(from, count);
    this.pages.splice(to, 0, ...moved);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  pageAt(index: number): PdfPage {
    return this.pages[index]!;
  }

  finalize(): Buffer {
    const objects: Buffer[] = [];
    const add = (body: Buffer | string): number => {
      objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
      return objects.length; // 1-based object number
    };

    // Reserve object numbers first where cross-references need them.
    // Layout: 1 catalog, 2 pages tree, then per page (page obj + content),
    // then per font (Type0, CIDFont, Descriptor, FontFile2, ToUnicode), then
    // info. Build bodies in that exact order.
    const catalogNum = 1;
    const pagesNum = 2;
    const pageNums: number[] = [];
    const contentNums: number[] = [];
    let next = 3;
    for (let i = 0; i < this.pages.length; i += 1) {
      pageNums.push(next);
      contentNums.push(next + 1);
      next += 2;
    }
    const fontNums = this.fonts.map(() => {
      const base = next;
      next += 5;
      return {
        type0: base,
        cid: base + 1,
        descriptor: base + 2,
        file: base + 3,
        toUnicode: base + 4,
      };
    });
    const infoNum = next;

    const fontResources = this.fonts
      .map((font, i) => `/${font.resourceName} ${fontNums[i]!.type0} 0 R`)
      .join(' ');

    add(`<< /Type /Catalog /Pages ${pagesNum} 0 R /Lang (${this.options.language}) >>`);
    add(
      `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${
        this.pages.length
      } >>`,
    );
    this.pages.forEach((page, i) => {
      add(
        `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${fmt(this.options.width)} ${fmt(
          this.options.height,
        )}] /Resources << /Font << ${fontResources} >> >> /Contents ${contentNums[i]} 0 R >>`,
      );
      add(streamObject(Buffer.from(page.ops.join('\n'), 'latin1')));
    });
    this.fonts.forEach((font, i) => {
      const nums = fontNums[i]!;
      const parsed = font.parsed;
      const scale = 1000 / parsed.unitsPerEm;
      const glyphs = [...font.used.keys()].filter((gid) => gid !== 0).sort((a, b) => a - b);
      const w = glyphs
        .map((gid) => `${gid} [${Math.round(parsed.advanceOf(gid) * scale)}]`)
        .join(' ');
      add(
        `<< /Type /Font /Subtype /Type0 /BaseFont /${sanitizeName(parsed.postScriptName)} ` +
          `/Encoding /Identity-H /DescendantFonts [${nums.cid} 0 R] /ToUnicode ${nums.toUnicode} 0 R >>`,
      );
      add(
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${sanitizeName(parsed.postScriptName)} ` +
          `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
          `/FontDescriptor ${nums.descriptor} 0 R /DW 500 /W [ ${w} ] /CIDToGIDMap /Identity >>`,
      );
      add(
        `<< /Type /FontDescriptor /FontName /${sanitizeName(parsed.postScriptName)} /Flags 32 ` +
          `/FontBBox [${parsed.bbox.map((v) => Math.round(v * scale)).join(' ')}] ` +
          `/ItalicAngle 0 /Ascent ${Math.round(parsed.ascent * scale)} ` +
          `/Descent ${Math.round(parsed.descent * scale)} /CapHeight ${Math.round(
            parsed.capHeight * scale,
          )} /StemV 80 /FontFile2 ${nums.file} 0 R >>`,
      );
      add(streamObject(parsed.bytes, ` /Length1 ${parsed.bytes.length}`));
      add(streamObject(Buffer.from(toUnicodeCMap(font), 'latin1')));
    });
    add(
      `<< /Title ${pdfTextString(this.options.title)} /Producer (Cogeto) ` +
        `/CreationDate (${pdfDate(this.options.creationDate)}) /ModDate (${pdfDate(
          this.options.creationDate,
        )}) >>`,
    );

    // Serialize with a cross-reference table.
    const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1')];
    let position = chunks[0]!.length;
    const offsets: number[] = [];
    objects.forEach((body, index) => {
      offsets.push(position);
      const object = Buffer.concat([
        Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
        body,
        Buffer.from('\nendobj\n', 'latin1'),
      ]);
      chunks.push(object);
      position += object.length;
    });
    const xrefStart = position;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    const id = createHash('md5').update(this.options.idSeed).digest('hex');
    xref +=
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R /Info ${infoNum} 0 R ` +
      `/ID [<${id}> <${id}>] >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}

function streamObject(bytes: Buffer, extra = ''): Buffer {
  const deflated = deflateSync(bytes, { level: 9 });
  return Buffer.concat([
    Buffer.from(
      `<< /Length ${deflated.length} /Filter /FlateDecode${extra} >>\nstream\n`,
      'latin1',
    ),
    deflated,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

/** UTF-16BE with BOM, hex-encoded — safe for any title text. */
function pdfTextString(text: string): string {
  let hex = 'feff';
  for (const ch of text) {
    const codePoint = ch.codePointAt(0)!;
    if (codePoint > 0xffff) {
      const high = 0xd800 + ((codePoint - 0x10000) >> 10);
      const low = 0xdc00 + ((codePoint - 0x10000) & 0x3ff);
      hex += high.toString(16).padStart(4, '0') + low.toString(16).padStart(4, '0');
    } else {
      hex += codePoint.toString(16).padStart(4, '0');
    }
  }
  return `<${hex}>`;
}

function pdfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function sanitizeName(name: string): string {
  return name.replace(/[^!-~]/g, '').replace(/[/#()<>[\]{}%]/g, '');
}

/** The standard ToUnicode CMap: glyph id → UTF-16BE, so text extraction and
 * copy/paste reproduce the quoted evidence exactly. */
function toUnicodeCMap(font: PdfFont): string {
  const entries = [...font.used.entries()].filter(([gid]) => gid !== 0).sort(([a], [b]) => a - b);
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const block = entries.slice(i, i + 100);
    body += `${block.length} beginbfchar\n`;
    for (const [gid, codePoint] of block) {
      let target: string;
      if (codePoint > 0xffff) {
        const high = 0xd800 + ((codePoint - 0x10000) >> 10);
        const low = 0xdc00 + ((codePoint - 0x10000) & 0x3ff);
        target = high.toString(16).padStart(4, '0') + low.toString(16).padStart(4, '0');
      } else {
        target = codePoint.toString(16).padStart(4, '0');
      }
      body += `<${gid.toString(16).padStart(4, '0')}> <${target}>\n`;
    }
    body += 'endbfchar\n';
  }
  return (
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    body +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'
  );
}

export function fmt(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}
