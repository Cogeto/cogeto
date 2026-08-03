import type { ReadSegment, SheetRowLocator } from './locator';

/**
 * Turning a grid into statements (V2.1 item 4.1, issue B1).
 *
 * This is the judgment in the spreadsheet readers, and it is shared by XLSX and
 * CSV because the problem is identical once the bytes are decoded: a
 * spreadsheet is not prose, and handing the extractor a dump of cells produces
 * garbage facts. Three rules do most of the work:
 *
 * 1. **A row carries its column context.** `Customer: Adriatic Foods; Amount:
 *    12500` extracts as a fact about a customer and an amount; `Adriatic
 *    Foods, 12500` extracts as nothing, or worse, as something invented. The
 *    column names are repeated on EVERY row rather than stated once at the top,
 *    because chunking splits by length and a header stranded in chunk 1 gives
 *    no context to chunk 2.
 * 2. **The header is found, not assumed.** Real sheets open with a title block,
 *    a logo row, a date, and only then the header.
 * 3. **Nothing decorative is emitted.** Empty rows, separator rows and repeated
 *    headers are skipped rather than turned into statements that say nothing.
 */

/** A row as the readers hand it over: 1-based row number, cells from column A. */
export interface TableRow {
  number: number;
  /** Rendered cell values, index 0 = column A. Empty cells are ''. */
  cells: string[];
}

export interface TableInput {
  /** Sheet name, or null for a single-table format (CSV). */
  name: string | null;
  /** 1-based sheet position; 1 for a single-table format. */
  index: number;
  /** Total sheets in the file, for the "sheet 1 of 3" context line. */
  sheetCount: number;
  rows: TableRow[];
  /** The file this table came from, for the CSV context line. */
  filename?: string | null;
  /**
   * The true number of rows the table holds, when the caller materialised only
   * a prefix of a very large sheet. Reported as-is so the truncation notice
   * quotes the file's own number rather than the prefix it looked at.
   */
  rowsTotal?: number;
}

export interface TableCaps {
  /** Max data rows turned into statements for THIS table. */
  maxRows: number;
}

export interface FlattenedTable {
  lines: FlattenedLine[];
  rowsRead: number;
  rowsTotal: number;
  truncated: boolean;
}

export interface FlattenedLine {
  text: string;
  locator: SheetRowLocator;
}

/** How wide a single cell may be before it is cut. Bounds pathological cells. */
const MAX_CELL_CHARS = 300;
/** How long one row statement may be. Bounds pathological rows. */
const MAX_STATEMENT_CHARS = 2000;
/** How many rows from the top may be inspected while looking for the header. */
const HEADER_SCAN_ROWS = 12;

/** A1-style column letter for a 1-based column index (1 → A, 27 → AA). */
export function columnLetter(index: number): string {
  let n = index;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters || 'A';
}

/** True for a row that carries nothing a reader should emit. */
function isEmptyRow(row: TableRow): boolean {
  return row.cells.every((cell) => cell.trim() === '');
}

/**
 * A separator or rule row: `---`, `===`, `***`. Spreadsheet authors draw lines
 * with characters, and a statement saying `Name: ---` is noise at best.
 */
function isDecorativeRow(row: TableRow): boolean {
  const filled = row.cells.filter((cell) => cell.trim() !== '');
  return filled.length > 0 && filled.every((cell) => /^[-=_*~.\s]+$/.test(cell.trim()));
}

function filledCount(row: TableRow): number {
  return row.cells.filter((cell) => cell.trim() !== '').length;
}

/** A value that reads as a number, a date or a currency amount, not a label. */
function looksLikeData(value: string): boolean {
  const text = value.trim();
  if (text === '') return false;
  if (/^[-+(]?[\d\s.,]+%?\)?$/.test(text)) return true; // 1 234,56  (1.234)  12%
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return true; // ISO date or datetime
  if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}\.?$/.test(text)) return true; // 20.7.2026.
  return false;
}

export interface HeaderDetection {
  /** 1-based row number of the header, or null when the table has none. */
  headerRow: number | null;
  /** Column labels, index 0 = column A. Never empty strings. */
  columns: string[];
  /** Rows above the header that describe the table (a title block). */
  titleRows: TableRow[];
  /** Index into `rows` of the first data row. */
  firstDataIndex: number;
}

/**
 * Finds the header row (issue B1).
 *
 * The rule: the first non-empty row that is as wide as the table and reads as
 * labels rather than as values. Narrower rows above it are a title block (a
 * report title, a date, a department) and are kept as context for the sheet
 * rather than parsed as columns or thrown away.
 *
 * When no row qualifies (a sheet that is data from row 1, which is the common
 * shape of an exported CSV with no header) the table gets positional column
 * names and every row including the first is data. Guessing a header here would
 * silently delete the first record of the file, which is worse than the
 * clumsier `Column A: 1001`.
 */
export function detectHeader(rows: TableRow[]): HeaderDetection {
  const scan = rows.slice(0, HEADER_SCAN_ROWS).filter((row) => !isEmptyRow(row));
  if (scan.length === 0) {
    return { headerRow: null, columns: [], titleRows: [], firstDataIndex: 0 };
  }
  const width = Math.max(...scan.map(filledCount));
  const titleRows: TableRow[] = [];

  for (const row of scan) {
    if (isDecorativeRow(row)) {
      continue;
    }
    const filled = filledCount(row);
    // A row far narrower than the table is a title block line, not the header.
    // (`width >= 2` keeps a genuinely single-column table from losing its head.)
    if (width >= 2 && filled <= Math.max(1, Math.floor(width / 2))) {
      titleRows.push(row);
      continue;
    }
    const values = row.cells.map((cell) => cell.trim()).filter((cell) => cell !== '');
    // A banner: one value merged across the whole table. It is as wide as the
    // header and is not one — a report title written across the top. Merged
    // HEADER groups repeat a label across the columns they span, which is why
    // the test is "every column says the same thing", not "any two do".
    if (values.length > 1 && new Set(values.map((value) => value.toLowerCase())).size === 1) {
      titleRows.push(row);
      continue;
    }
    const dataLike = values.filter(looksLikeData).length;
    // Labels: mostly non-numeric. A row of numbers and dates is data.
    if (dataLike * 2 <= values.length) {
      const index = rows.indexOf(row);
      return {
        headerRow: row.number,
        columns: namedColumns(row),
        titleRows,
        firstDataIndex: index + 1,
      };
    }
    break; // the first table-width row is data → this table has no header
  }

  return {
    headerRow: null,
    columns: positionalColumns(Math.max(width, ...scan.map((row) => row.cells.length))),
    // With no header, a "title" candidate is just the first data row: give it
    // back rather than swallowing it.
    titleRows: [],
    firstDataIndex: 0,
  };
}

/** Header labels, with positional names filling gaps in the header row. */
function namedColumns(row: TableRow): string[] {
  const seen = new Map<string, number>();
  return row.cells.map((cell, index) => {
    const label = cell.trim();
    if (label === '') return columnName(index);
    // Merged header cells legitimately repeat across the columns they span;
    // disambiguate so a locator's column list stays meaningful.
    const count = (seen.get(label.toLowerCase()) ?? 0) + 1;
    seen.set(label.toLowerCase(), count);
    return count === 1 ? label : `${label} (${columnLetter(index + 1)})`;
  });
}

function positionalColumns(width: number): string[] {
  return Array.from({ length: width }, (_, index) => columnName(index));
}

/** The fallback label for a column with no header: its spreadsheet letter. */
function columnName(index: number): string {
  return `Column ${columnLetter(index + 1)}`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Flattens one table into statements with their locators.
 *
 * The first line is the table's context (which sheet, of how many, plus any
 * title block); every following line is one data row. Nothing about truncation
 * is written INTO the text: a sentence saying "4,950 further rows were not
 * read" is a sentence the extractor would happily turn into a fact. Truncation
 * is reported structurally in {@link FlattenedTable} and recorded on the source.
 */
export function flattenTable(input: TableInput, caps: TableCaps): FlattenedTable {
  const header = detectHeader(input.rows);
  const lines: FlattenedLine[] = [];
  const contextRow = header.headerRow ?? input.rows[header.firstDataIndex]?.number ?? 1;
  const width = Math.max(header.columns.length, ...input.rows.map((row) => row.cells.length), 1);

  const contextLocator: SheetRowLocator = {
    kind: 'sheet_row',
    sheet: input.name,
    sheetIndex: input.index,
    row: contextRow,
    cellRange: `${columnLetter(1)}${contextRow}:${columnLetter(width)}${contextRow}`,
    columns: header.columns.filter((column) => column !== ''),
  };
  lines.push({ text: contextLine(input, header), locator: contextLocator });

  const dataRows = input.rows.slice(header.firstDataIndex);
  const candidates = dataRows.filter((row) => !isEmptyRow(row) && !isDecorativeRow(row));
  let rowsRead = 0;

  for (const row of candidates) {
    if (rowsRead >= caps.maxRows) break;
    // A row that repeats the header (a table continued after a page break)
    // carries no information a statement could hold.
    if (header.headerRow !== null && repeatsHeader(row, header.columns)) continue;

    const parts: string[] = [];
    const columns: string[] = [];
    let firstColumn = Number.POSITIVE_INFINITY;
    let lastColumn = 0;
    row.cells.forEach((cell, index) => {
      const value = cell.trim();
      if (value === '') return;
      const column = header.columns[index] ?? columnName(index);
      parts.push(`${column}: ${clip(value, MAX_CELL_CHARS)}`);
      columns.push(column);
      firstColumn = Math.min(firstColumn, index + 1);
      lastColumn = Math.max(lastColumn, index + 1);
    });
    if (parts.length === 0) continue;

    const cellRange =
      firstColumn === lastColumn
        ? `${columnLetter(firstColumn)}${row.number}`
        : `${columnLetter(firstColumn)}${row.number}:${columnLetter(lastColumn)}${row.number}`;
    lines.push({
      text: `Row ${row.number}: ${clip(parts.join('; '), MAX_STATEMENT_CHARS)}`,
      locator: {
        kind: 'sheet_row',
        sheet: input.name,
        sheetIndex: input.index,
        row: row.number,
        cellRange,
        columns,
      },
    });
    rowsRead += 1;
  }

  const rowsTotal = Math.max(input.rowsTotal ?? 0, candidates.length);
  return { lines, rowsRead, rowsTotal, truncated: rowsTotal > rowsRead };
}

/** True when the row is the header repeated further down the sheet. */
function repeatsHeader(row: TableRow, columns: string[]): boolean {
  const values = row.cells.map((cell) => cell.trim().toLowerCase()).filter((cell) => cell !== '');
  if (values.length === 0) return false;
  const labels = new Set(columns.map((column) => column.toLowerCase()));
  return values.every((value) => labels.has(value));
}

/**
 * The table's one context line: which sheet this is, what the title block above
 * the header said, and what the columns are.
 */
function contextLine(input: TableInput, header: HeaderDetection): string {
  const parts: string[] = [];
  if (input.name !== null) {
    parts.push(
      input.sheetCount > 1
        ? `Sheet "${input.name}" (sheet ${input.index} of ${input.sheetCount})`
        : `Sheet "${input.name}"`,
    );
  } else {
    parts.push(input.filename ? `Table from ${input.filename}` : 'Table');
  }
  const title = header.titleRows
    .map((row) => {
      const cells = row.cells.map((cell) => cell.trim()).filter((cell) => cell !== '');
      // A merged title repeats its value across every column it spans; say it
      // once. Adjacent-only, so a row that genuinely repeats a word keeps it.
      return cells.filter((cell, index) => cell !== cells[index - 1]).join(' ');
    })
    .filter((line) => line !== '');
  parts.push(...title);
  if (header.columns.length > 0) {
    parts.push(`Columns: ${header.columns.filter((column) => column !== '').join(', ')}`);
  }
  return joinSentences(parts);
}

/**
 * Joins into sentences without doubling a full stop. Title-block text is the
 * document's own writing and often already ends in one, and `2026.. Prepared`
 * is the kind of small wrongness that makes a reader distrust the whole line.
 */
function joinSentences(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .reduce(
      (joined, part) =>
        joined === '' ? part : `${joined}${/[.!?]$/.test(joined) ? '' : '.'} ${part}`,
      '',
    );
}

/**
 * Joins flattened lines into the reader's text, computing each line's segment.
 * One blank line between tables, so a chunk boundary falls between sheets more
 * often than inside one.
 */
export function renderTables(tables: FlattenedTable[]): { text: string; segments: ReadSegment[] } {
  const segments: ReadSegment[] = [];
  const chunks: string[] = [];
  let at = 0;
  tables.forEach((table, tableIndex) => {
    if (tableIndex > 0) {
      chunks.push('\n');
      at += 1;
    }
    table.lines.forEach((line) => {
      segments.push({ start: at, end: at + line.text.length, locator: line.locator });
      chunks.push(line.text);
      chunks.push('\n');
      at += line.text.length + 1;
    });
  });
  const text = chunks.join('').trimEnd();
  return { text, segments: segments.filter((segment) => segment.start < text.length) };
}
