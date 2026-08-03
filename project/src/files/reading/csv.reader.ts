import { parse } from 'csv-parse';
import iconv from 'iconv-lite';
import { CSV_CONTENT_TYPE } from '@cogeto/shared';
import { readFailed } from './reader';
import type { DocumentReader, ReadInput, ReadResult, SheetReadDetail } from './reader';
import { flattenTable, renderTables } from './table';
import type { TableRow } from './table';

/**
 * CSV, via `csv-parse` for the grammar (quoted fields, embedded newlines,
 * escaped quotes) and our own detection for the two things a CSV file does not
 * tell you: what separates its fields and how its bytes encode text
 * (V2.1 item 4.1, issue B5).
 *
 * **Encoding, in order, and the fallback is documented because it is a guess:**
 *   1. A byte-order mark decides, when present (UTF-8, UTF-16 LE or BE).
 *   2. Otherwise the bytes are decoded as UTF-8 in STRICT mode. Valid UTF-8 is
 *      not a coincidence: a file that decodes cleanly is UTF-8.
 *   3. Otherwise the file is legacy single-byte text, and nothing in the bytes
 *      can say which codepage. It is decoded with the configured fallback
 *      (`COGETO_PARSE_CSV_FALLBACK_ENCODING`, default `windows-1250`), chosen
 *      because Croatian is the non-English corpus language and 1250 is the
 *      Windows codepage that carries č, ć, ž, š and đ. The choice only ever
 *      affects bytes ≥ 0x80, so English-only files are unaffected by it.
 *   The encoding that was used is recorded on the read report, so a wrong guess
 *   is visible rather than mysterious.
 *
 * **Delimiter:** the candidates are comma, semicolon, tab and pipe. The winner
 * is the one that splits the sampled lines into the most consistent number of
 * fields; a tie or no signal at all falls back to comma. Semicolon matters in
 * practice: it is what a Croatian or German Excel writes, because those locales
 * use the comma as the decimal separator.
 *
 * **No header row** is a supported shape, not an error: `table.ts` decides, and
 * when it decides there is none, the first line stays data under positional
 * column names instead of being silently consumed as labels.
 */
export class CsvReader implements DocumentReader {
  readonly format = 'csv' as const;
  readonly contentTypes = [CSV_CONTENT_TYPE];
  readonly extensions = ['.csv', '.tsv'];
  readonly detectable = false;
  readonly input = 'bytes' as const;
  readonly granularity = 'sheet_row' as const;

  async read({ bytes, filename, caps }: ReadInput): Promise<ReadResult> {
    const { text: decoded, encoding } = decodeText(bytes, caps.csvFallbackEncoding);
    const delimiter = detectDelimiter(decoded);

    let records: string[][];
    try {
      records = await parseCsv(decoded, delimiter);
    } catch (error) {
      throw readFailed('could not parse CSV', {
        reasonCode: 'parse_failed',
        format: 'csv',
        cause: error,
      });
    }

    // The record number IS the row number a spreadsheet program shows when it
    // opens this file, which is what makes the locator usable: a field with an
    // embedded newline spans several LINES but remains one row.
    const rows: TableRow[] = records.map((record, index) => ({
      number: index + 1,
      cells: record.map((cell) => cell.trim()),
    }));

    const maxRows = Math.min(caps.maxSheetRows, caps.maxFileRows);
    const table = flattenTable(
      { name: null, index: 1, sheetCount: 1, rows, filename },
      { maxRows },
    );
    const { text, segments } = renderTables(table.rowsRead > 0 ? [table] : []);
    const sheets: SheetReadDetail[] = [
      {
        name: null,
        index: 1,
        rowsRead: table.rowsRead,
        rowsTotal: table.rowsTotal,
        truncated: table.truncated,
      },
    ];

    return {
      text,
      segments,
      report: {
        format: 'csv',
        granularity: 'sheet_row',
        outcome: text.length === 0 ? 'empty' : table.truncated ? 'truncated' : 'read',
        reasonCode:
          text.length === 0
            ? 'no_text'
            : table.truncated
              ? table.rowsRead >= caps.maxSheetRows
                ? 'row_cap_sheet'
                : 'row_cap_file'
              : null,
        segments: segments.length,
        sheets,
        valuesUnavailable: 0,
        unavailableCells: [],
        delimiter: DELIMITER_NAMES[delimiter] ?? delimiter,
        encoding,
      },
    };
  }
}

/** How many lines the delimiter sniff looks at. */
const DELIMITER_SAMPLE_LINES = 20;
const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const;
const DELIMITER_NAMES: Record<string, string> = {
  ',': 'comma',
  ';': 'semicolon',
  '\t': 'tab',
  '|': 'pipe',
};

export interface DecodedText {
  text: string;
  encoding: string;
}

/** Byte-order marks, longest first so UTF-8's three bytes win over a prefix. */
const BOMS: ReadonlyArray<{ bytes: number[]; encoding: string; label: string }> = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf8', label: 'utf-8 (BOM)' },
  { bytes: [0xff, 0xfe], encoding: 'utf16le', label: 'utf-16le (BOM)' },
  { bytes: [0xfe, 0xff], encoding: 'utf16be', label: 'utf-16be (BOM)' },
];

/** Decodes the bytes to text, reporting which encoding was used. */
export function decodeText(bytes: Buffer, fallbackEncoding: string): DecodedText {
  for (const bom of BOMS) {
    if (bytes.length >= bom.bytes.length && bom.bytes.every((byte, i) => bytes[i] === byte)) {
      const body = bytes.subarray(bom.bytes.length);
      return { text: iconv.decode(body, bom.encoding), encoding: bom.label };
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // Not UTF-8: legacy single-byte text. Nothing in the bytes says which
    // codepage, so the configured fallback decides and the report says so.
  }
  if (!iconv.encodingExists(fallbackEncoding)) {
    throw readFailed(`unknown fallback encoding '${fallbackEncoding}'`, {
      reasonCode: 'undecodable_text',
      format: 'csv',
    });
  }
  return { text: iconv.decode(bytes, fallbackEncoding), encoding: fallbackEncoding.toLowerCase() };
}

/**
 * Picks the field delimiter by consistency across sampled lines: the candidate
 * that yields the same field count on the most lines, requiring at least two
 * fields. Ties and a total absence of signal fall back to the comma, which is
 * the documented default and the one the format is named after.
 *
 * Counting ignores anything inside double quotes, so a comma in
 * `"Zagreb, Croatia"` cannot outvote the real separator.
 */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return ',';
  const sample = lines.slice(0, DELIMITER_SAMPLE_LINES);

  let best = ',';
  let bestScore = 0;
  for (const candidate of DELIMITER_CANDIDATES) {
    const counts = sample.map((line) => countOutsideQuotes(line, candidate));
    const tally = new Map<number, number>();
    for (const count of counts) {
      if (count > 0) tally.set(count, (tally.get(count) ?? 0) + 1);
    }
    if (tally.size === 0) continue;
    // Score: how many lines agree on the most common non-zero field count,
    // weighted by that count so a real separator beats a stray character that
    // happens to appear once on every line.
    let modeCount = 0;
    let modeLines = 0;
    for (const [count, lineCount] of tally) {
      if (lineCount > modeLines || (lineCount === modeLines && count > modeCount)) {
        modeCount = count;
        modeLines = lineCount;
      }
    }
    const score = modeLines * 10 + Math.min(modeCount, 10);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Occurrences of `char` outside double-quoted regions of one line. */
function countOutsideQuotes(line: string, char: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    const current = line[i];
    if (current === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1; // an escaped quote inside a quoted field
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && current === char) count += 1;
  }
  return count;
}

/**
 * Parses with the tolerances a real-world export needs: ragged rows are kept
 * (a short row is data, not a parse error), and a stray quote inside an
 * unquoted field does not abort the file. Nothing here invents a value; the
 * tolerances only decide whether the read continues.
 */
function parseCsv(text: string, delimiter: string): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    parse(
      text,
      {
        delimiter,
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: false,
        trim: false,
      },
      (error, records: string[][]) => (error ? reject(error) : resolve(records ?? [])),
    );
  });
}
