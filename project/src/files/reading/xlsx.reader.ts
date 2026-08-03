import ExcelJS from 'exceljs';
import { XLSX_CONTENT_TYPE } from '@cogeto/shared';
import { readFailed } from './reader';
import type {
  DocumentReader,
  ReadInput,
  ReadReasonCode,
  ReadResult,
  SheetReadDetail,
} from './reader';
import { columnLetter, flattenTable, renderTables } from './table';
import type { FlattenedTable, TableRow } from './table';

/**
 * XLSX, via `exceljs` (V2.1 item 4.1, issue B).
 *
 * The library exists to be wrong about nothing at the container layer: zip
 * parts, shared strings, and above all the number formats that decide whether
 * `45123` is a quantity or a date. Everything above that layer, the judgment
 * about what a row MEANS, is ours and lives in `table.ts`.
 *
 * Two decisions worth stating:
 *
 * - **Formulas contribute their computed value, never their text** (issue B4).
 *   A workbook stores the last value the spreadsheet program calculated; that
 *   cached value is what a human saw and what a fact can be verified against.
 *   `SUM(C3:C4)` is a recipe, and a fact reading "the total is SUM(C3:C4)" is
 *   worse than no fact. When the cache is absent (a file written by a tool that
 *   never calculated) or the cached value is an error, the cell is left OUT of
 *   the statement and recorded in the read report by its reference, so "we
 *   could not read cell C5" stays a visible fact about the read rather than a
 *   silent gap.
 * - **Merged cells resolve to their master's value.** A label merged across
 *   four columns applies to all four, which is exactly what the author meant by
 *   merging them.
 */
export class XlsxReader implements DocumentReader {
  readonly format = 'xlsx' as const;
  readonly contentTypes = [XLSX_CONTENT_TYPE];
  readonly extensions = ['.xlsx'];
  readonly detectable = true;
  readonly input = 'bytes' as const;
  readonly granularity = 'sheet_row' as const;

  async read({ bytes, caps }: ReadInput): Promise<ReadResult> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    } catch (error) {
      throw readFailed('could not parse XLSX', {
        reasonCode: 'parse_failed',
        format: 'xlsx',
        cause: error,
      });
    }

    const sheets: SheetReadDetail[] = [];
    const tables: FlattenedTable[] = [];
    const unavailable: string[] = [];
    let unavailableCount = 0;
    let cappedBy: Extract<ReadReasonCode, 'row_cap_sheet' | 'row_cap_file'> | null = null;
    let fileBudget = caps.maxFileRows;

    const worksheets = workbook.worksheets;
    worksheets.forEach((worksheet, position) => {
      const sheetIndex = position + 1;
      const scanLimit = Math.min(worksheet.rowCount, MAX_SCANNED_ROWS);
      const columnCount = Math.max(worksheet.columnCount, 1);
      const rows: TableRow[] = [];
      for (let number = 1; number <= scanLimit; number += 1) {
        const row = worksheet.getRow(number);
        const cells: string[] = [];
        for (let column = 1; column <= columnCount; column += 1) {
          const cell = row.getCell(column);
          const rendered = renderCell(cell.value);
          if (rendered === UNAVAILABLE) {
            unavailableCount += 1;
            if (unavailable.length < MAX_REPORTED_CELLS) {
              unavailable.push(`${worksheet.name}!${columnLetter(column)}${number}`);
            }
            cells.push('');
            continue;
          }
          cells.push(rendered);
        }
        rows.push({ number, cells });
      }

      const maxRows = Math.min(caps.maxSheetRows, Math.max(fileBudget, 0));
      const table = flattenTable(
        {
          name: worksheet.name,
          index: sheetIndex,
          sheetCount: worksheets.length,
          rows,
          rowsTotal: worksheet.rowCount > MAX_SCANNED_ROWS ? worksheet.rowCount : undefined,
        },
        { maxRows },
      );
      fileBudget -= table.rowsRead;
      if (table.truncated) {
        // Which cap bit matters: one sheet being long is a different message
        // from a workbook that ran out of budget partway through sheet four.
        cappedBy = table.rowsRead >= caps.maxSheetRows ? 'row_cap_sheet' : 'row_cap_file';
      }
      sheets.push({
        name: worksheet.name,
        index: sheetIndex,
        rowsRead: table.rowsRead,
        rowsTotal: table.rowsTotal,
        truncated: table.truncated,
      });
      // A sheet that produced nothing but its own context line adds noise, not
      // content: drop it rather than tell the extractor about an empty sheet.
      if (table.rowsRead > 0) tables.push(table);
    });

    const { text, segments } = renderTables(tables);
    const truncated = sheets.some((sheet) => sheet.truncated);
    return {
      text,
      segments,
      report: {
        format: 'xlsx',
        granularity: 'sheet_row',
        outcome: text.length === 0 ? 'empty' : truncated ? 'truncated' : 'read',
        reasonCode: text.length === 0 ? 'no_text' : truncated ? cappedBy : null,
        segments: segments.length,
        sheets,
        valuesUnavailable: unavailableCount,
        unavailableCells: unavailable,
      },
    };
  }
}

/** Hard guard on how many rows of one sheet are inspected at all. */
const MAX_SCANNED_ROWS = 200_000;
/** How many unreadable cell references the report lists by name. */
const MAX_REPORTED_CELLS = 20;

/**
 * Sentinel: the cell holds something whose value cannot be recovered. The NUL
 * prefix makes a collision with a real cell value impossible: string cells are
 * trimmed, and a control character does not survive a spreadsheet round trip.
 */
const UNAVAILABLE = '\u0000unavailable';

/**
 * One cell as text. Dates render ISO (the extraction prompt resolves dates from
 * ISO reliably in both corpus languages); numbers render plainly, with no
 * thousands separator, so `1234.5` cannot be misread as two values.
 */
export function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return renderDate(value);
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  // An error value: the spreadsheet itself could not produce a number here.
  if (typeof record['error'] === 'string') return UNAVAILABLE;
  // A formula: the cached result is the value a human saw.
  if ('formula' in record || 'sharedFormula' in record) {
    if (!('result' in record) || record['result'] === undefined || record['result'] === null) {
      return UNAVAILABLE;
    }
    return renderCell(record['result']);
  }
  if (Array.isArray(record['richText'])) {
    return (record['richText'] as Array<{ text?: unknown }>)
      .map((run) => (typeof run.text === 'string' ? run.text : ''))
      .join('')
      .trim();
  }
  // A hyperlink cell: the visible text, falling back to the target.
  if ('hyperlink' in record) {
    const text = record['text'];
    if (typeof text === 'string' && text.trim() !== '') return text.trim();
    return typeof record['hyperlink'] === 'string' ? record['hyperlink'] : '';
  }
  return '';
}

/** ISO date for a midnight value, ISO datetime when a time of day is meant. */
function renderDate(value: Date): string {
  if (Number.isNaN(value.getTime())) return '';
  const iso = value.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}
