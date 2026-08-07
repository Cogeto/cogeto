import { fmt, PdfFont, PdfPage, PdfWriter } from './pdf-writer';
import type { ParsedLogo } from './svg-logo';

/**
 * A flowing document composer over the PDF writer (V2.3 item 6.2): headings
 * with a table of contents, wrapped paragraphs, key-value blocks, tables that
 * survive page breaks with their header row repeated, and visually distinct
 * quote blocks for evidence spans. Restrained by design: black text, a light
 * gray only where structure needs it, correct in black-and-white print.
 */

export interface ComposerFonts {
  regular: PdfFont;
  bold: PdfFont;
}

export interface TocEntry {
  level: 1 | 2;
  title: string;
  /** Index into the composer's own page sequence (0-based). */
  pageIndex: number;
}

export const PAGE = { width: 595.28, height: 841.89 } as const; // A4 portrait
export const MARGIN = { top: 64, right: 56, bottom: 64, left: 56 } as const;
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

const GRAY_TEXT = 0.42;
const QUOTE_BG = 0.955;
const RULE_GRAY = 0.8;

export class Composer {
  readonly toc: TocEntry[] = [];
  private readonly pages: PdfPage[] = [];
  private page!: PdfPage;
  private y = 0;

  constructor(
    private readonly writer: PdfWriter,
    private readonly fonts: ComposerFonts,
  ) {
    this.newPage();
  }

  get pageList(): PdfPage[] {
    return this.pages;
  }

  get currentPageIndex(): number {
    return this.pages.length - 1;
  }

  newPage(): void {
    this.page = this.writer.addPage();
    this.pages.push(this.page);
    this.y = PAGE.height - MARGIN.top;
  }

  /** Break unless `height` points fit above the bottom margin. */
  ensure(height: number): void {
    if (this.y - height < MARGIN.bottom) this.newPage();
  }

  spacer(height: number): void {
    this.y -= height;
  }

  rule(): void {
    this.ensure(10);
    this.page.op(
      `q ${fmt(RULE_GRAY)} G 0.6 w ${fmt(MARGIN.left)} ${fmt(this.y)} m ${fmt(
        PAGE.width - MARGIN.right,
      )} ${fmt(this.y)} l S Q`,
    );
    this.y -= 10;
  }

  heading(level: 1 | 2 | 3, text: string, options: { toc?: boolean } = {}): void {
    const size = level === 1 ? 16 : level === 2 ? 12.5 : 10.5;
    const before = level === 1 ? 18 : 12;
    const after = level === 1 ? 10 : 7;
    // Keep the heading with at least three lines of what follows.
    this.ensure(before + size * 1.3 + after + 36);
    this.y -= before;
    this.drawLine(this.fonts.bold, size, MARGIN.left, text, 0);
    this.y -= size * 1.3 + after;
    if (options.toc !== false && level <= 2) {
      this.toc.push({ level: level as 1 | 2, title: text, pageIndex: this.currentPageIndex });
    }
  }

  para(
    text: string,
    options: {
      size?: number;
      bold?: boolean;
      gray?: boolean;
      indent?: number;
      after?: number;
      lineHeight?: number;
    } = {},
  ): void {
    const size = options.size ?? 9.5;
    const font = options.bold ? this.fonts.bold : this.fonts.regular;
    const indent = options.indent ?? 0;
    const width = CONTENT_WIDTH - indent;
    const lineHeight = size * (options.lineHeight ?? 1.42);
    for (const paragraph of text.split('\n')) {
      for (const line of this.wrap(paragraph, font, size, width)) {
        this.ensure(lineHeight);
        this.drawLine(font, size, MARGIN.left + indent, line, options.gray ? GRAY_TEXT : 0);
        this.y -= lineHeight;
      }
    }
    this.y -= options.after ?? 5;
  }

  /** Label/value rows; labels gray, values black, aligned in two columns. */
  keyValue(rows: [string, string][], options: { labelWidth?: number } = {}): void {
    const size = 9.5;
    const labelWidth = options.labelWidth ?? 170;
    const valueWidth = CONTENT_WIDTH - labelWidth - 8;
    const lineHeight = size * 1.45;
    for (const [label, value] of rows) {
      const lines = this.wrap(value, this.fonts.regular, size, valueWidth);
      const rowHeight = Math.max(1, lines.length) * lineHeight + 2;
      this.ensure(rowHeight);
      this.drawLine(this.fonts.regular, size, MARGIN.left, label, GRAY_TEXT);
      lines.forEach((line, i) => {
        this.drawTextAt(
          this.fonts.regular,
          size,
          MARGIN.left + labelWidth + 8,
          this.y - size - i * lineHeight,
          line,
          0,
        );
      });
      this.y -= rowHeight;
    }
    this.y -= 4;
  }

  /**
   * A table whose header repeats after every page break and whose rows never
   * split: a row that does not fit moves whole to the next page.
   */
  table(columns: { header: string; width: number }[], rows: string[][]): void {
    const size = 8.5;
    const lineHeight = size * 1.4;
    const pad = 4;
    const total = columns.reduce((sum, c) => sum + c.width, 0);
    const scale = CONTENT_WIDTH / total;
    const widths = columns.map((c) => c.width * scale);

    const header = () => {
      const headerLines = columns.map((column, i) =>
        this.wrap(column.header, this.fonts.bold, size, widths[i]! - pad * 2),
      );
      const headerRows = Math.max(1, ...headerLines.map((lines) => lines.length));
      const height = headerRows * lineHeight + pad * 2;
      this.ensure(height + lineHeight * 2);
      this.page.op(
        `q ${fmt(0.92)} g ${fmt(MARGIN.left)} ${fmt(this.y - height)} ${fmt(
          CONTENT_WIDTH,
        )} ${fmt(height)} re f Q`,
      );
      let x = MARGIN.left;
      headerLines.forEach((lines, i) => {
        lines.forEach((line, j) => {
          this.drawTextAt(
            this.fonts.bold,
            size,
            x + pad,
            this.y - pad - size - j * lineHeight,
            line,
            0,
          );
        });
        x += widths[i]!;
      });
      this.y -= height + 2;
    };

    header();
    for (const row of rows) {
      const cellLines = row.map((cell, i) =>
        this.wrap(cell, this.fonts.regular, size, widths[i]! - pad * 2),
      );
      const rowLines = Math.max(1, ...cellLines.map((lines) => lines.length));
      const rowHeight = rowLines * lineHeight + pad;
      if (this.y - rowHeight < MARGIN.bottom) {
        this.newPage();
        header();
      }
      let x = MARGIN.left;
      cellLines.forEach((lines, i) => {
        lines.forEach((line, j) => {
          this.drawTextAt(
            this.fonts.regular,
            size,
            x + pad,
            this.y - size - j * lineHeight,
            line,
            0,
          );
        });
        x += widths[i]!;
      });
      this.y -= rowHeight + pad;
      this.page.op(
        `q ${fmt(RULE_GRAY)} G 0.4 w ${fmt(MARGIN.left)} ${fmt(this.y + pad * 0.5)} m ${fmt(
          MARGIN.left + CONTENT_WIDTH,
        )} ${fmt(this.y + pad * 0.5)} l S Q`,
      );
    }
    this.y -= 8;
  }

  /**
   * An evidence quote: indented, light gray panel with a solid left rule, so
   * a verbatim span is unmistakable beside narrative text and remains
   * distinct in black-and-white print. Truncation is VISIBLE: the note line
   * is printed whenever the text was cut, and the JSON keeps the full text.
   */
  quote(text: string, options: { maxChars: number; truncatedNote: string }): void {
    const size = 9;
    const lineHeight = size * 1.45;
    const indent = 14;
    const padX = 10;
    const padY = 7;
    const width = CONTENT_WIDTH - indent - padX * 2;
    const truncated = text.length > options.maxChars;
    const shown = truncated ? `${text.slice(0, options.maxChars).trimEnd()} […]` : text;
    const lines = shown
      .split('\n')
      .flatMap((paragraph) => this.wrap(paragraph, this.fonts.regular, size, width));

    // Render block by block across page breaks; each block gets its own panel.
    let index = 0;
    while (index < lines.length) {
      const available = Math.floor((this.y - MARGIN.bottom - padY * 2) / lineHeight);
      if (available < 2 && this.y < PAGE.height - MARGIN.top) {
        this.newPage();
        continue;
      }
      const take = Math.min(lines.length - index, Math.max(available, 2));
      const blockHeight = take * lineHeight + padY * 2;
      this.page.op(
        `q ${fmt(QUOTE_BG)} g ${fmt(MARGIN.left + indent)} ${fmt(
          this.y - blockHeight,
        )} ${fmt(CONTENT_WIDTH - indent)} ${fmt(blockHeight)} re f Q`,
      );
      this.page.op(
        `q 0.25 g ${fmt(MARGIN.left + indent)} ${fmt(this.y - blockHeight)} 2 ${fmt(
          blockHeight,
        )} re f Q`,
      );
      let lineY = this.y - padY - size;
      for (const line of lines.slice(index, index + take)) {
        this.drawTextAt(this.fonts.regular, size, MARGIN.left + indent + padX, lineY, line, 0.08);
        lineY -= lineHeight;
      }
      this.y -= blockHeight + 2;
      index += take;
    }
    if (truncated) {
      this.para(options.truncatedNote, { size: 7.5, gray: true, indent: indent + padX, after: 4 });
    } else {
      this.y -= 3;
    }
  }

  /** Draw the logo at its provided proportions, `targetWidth` points wide. */
  logo(logo: ParsedLogo, x: number, yTop: number, targetWidth: number): void {
    const scale = targetWidth / logo.viewBox.width;
    this.page.op(
      `q ${fmt(scale)} 0 0 ${fmt(scale)} ${fmt(x)} ${fmt(
        yTop - logo.viewBox.height * scale,
      )} cm\n${logo.operators}\nQ`,
    );
  }

  // ── Low level ────────────────────────────────────────────────────────────

  private drawLine(font: PdfFont, size: number, x: number, text: string, gray: number): void {
    this.drawTextAt(font, size, x, this.y - size, text, gray);
  }

  drawTextAt(
    font: PdfFont,
    size: number,
    x: number,
    baselineY: number,
    text: string,
    gray: number,
  ): void {
    this.drawTextOn(this.page, font, size, x, baselineY, text, gray);
  }

  /** Page-targeted text draw — footers and the TOC write onto pages that are
   * not the composer's current one. */
  drawTextOn(
    page: PdfPage,
    font: PdfFont,
    size: number,
    x: number,
    baselineY: number,
    text: string,
    gray: number,
  ): void {
    if (!text) return;
    const { hex } = font.encode(text);
    page.op(
      `BT ${fmt(gray)} g /${font.resourceName} ${fmt(size)} Tf ${fmt(x)} ${fmt(
        baselineY,
      )} Td <${hex}> Tj ET`,
    );
  }

  /** Word wrap with measurement; unbreakable words hard-split to fit. */
  wrap(text: string, font: PdfFont, size: number, width: number): string[] {
    if (!text) return [''];
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const lines: string[] = [];
    let line = '';
    const push = () => {
      if (line) lines.push(line);
      line = '';
    };
    for (let word of words) {
      while (font.widthOf(word, size) > width) {
        // Hard-split an over-long token (a URL, an object key).
        push();
        let cut = word.length;
        while (cut > 1 && font.widthOf(word.slice(0, cut), size) > width) cut -= 1;
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOf(candidate, size) <= width) {
        line = candidate;
      } else {
        push();
        line = word;
      }
    }
    push();
    return lines.length > 0 ? lines : [''];
  }

  get cursorY(): number {
    return this.y;
  }

  set cursorY(value: number) {
    this.y = value;
  }
}
