import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { locateSpan } from './locator';
import type { SheetRowLocator } from './locator';
import { readDocument } from './registry';

/**
 * The golden corpus and the reader, pinned to each other (V2.1 item 4.1).
 *
 * The eval harness scores `source.txt`. For a spreadsheet case that text is not
 * something a human wrote: it is what the reading layer produced from
 * `source.xlsx` or `source.csv`, which sit in the same directory. Nothing
 * connects the two at eval time, so without this spec a reader change would
 * silently leave the corpus scoring text no reader produces any more, and the
 * cached eval fixtures would keep passing over it.
 *
 * So: read every committed spreadsheet fixture under the options its `read.json`
 * declares, and require the result to be exactly the committed `source.txt`.
 * When a reader change is deliberate, `scripts/dev/build-spreadsheet-fixtures.mjs`
 * regenerates the text and the eval cache must be refreshed in the same change.
 */

const goldenDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../eval/golden',
);

interface SpreadsheetCase {
  caseId: string;
  dir: string;
  sourceFile: string;
  read: { declaredContentType?: string; filename?: string; caps?: Record<string, number> };
}

async function spreadsheetCases(): Promise<SpreadsheetCase[]> {
  const found: SpreadsheetCase[] = [];
  for (const lang of ['en', 'hr']) {
    const langDir = path.join(goldenDir, lang);
    for (const dir of (await readdir(langDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      const base = path.join(langDir, dir);
      const entries = await readdir(base);
      const sourceFile = entries.find((name) => name === 'source.xlsx' || name === 'source.csv');
      if (!sourceFile || !entries.includes('read.json')) continue;
      found.push({
        caseId: dir,
        dir: base,
        sourceFile,
        read: JSON.parse(await readFile(path.join(base, 'read.json'), 'utf8')),
      });
    }
  }
  return found;
}

const cases = await spreadsheetCases();

describe('the spreadsheet golden fixtures', () => {
  it('exist in both languages, covering all five scenarios', () => {
    // Five scenarios per language: clean sheet, title block, multi-sheet
    // workbook, semicolon CSV in a Windows encoding, and the row cap.
    expect(cases.filter((testCase) => testCase.caseId.startsWith('en-'))).toHaveLength(5);
    expect(cases.filter((testCase) => testCase.caseId.startsWith('hr-'))).toHaveLength(5);
  });

  for (const testCase of cases) {
    it(`${testCase.caseId}: the corpus text is what the reader produces`, async () => {
      const bytes = await readFile(path.join(testCase.dir, testCase.sourceFile));
      const committed = await readFile(path.join(testCase.dir, 'source.txt'), 'utf8');
      const result = await readDocument(bytes, testCase.read);
      expect(`${result.text}\n`).toBe(committed);
    });

    it(`${testCase.caseId}: every statement traces to a cell range`, async () => {
      const bytes = await readFile(path.join(testCase.dir, testCase.sourceFile));
      const result = await readDocument(bytes, testCase.read);
      expect(result.report.granularity).toBe('sheet_row');
      expect(result.segments.length).toBeGreaterThan(0);

      for (const segment of result.segments) {
        const locator = segment.locator as SheetRowLocator;
        expect(locator.kind).toBe('sheet_row');
        expect(locator.row).toBeGreaterThan(0);
        // An A1-style reference or range, which is what makes it usable: it can
        // be typed into the name box of the program that wrote the file.
        expect(locator.cellRange).toMatch(/^[A-Z]+\d+(:[A-Z]+\d+)?$/);
      }

      // Round trip: a statement's own text resolves back to its own locator.
      const statement = result.text.split('\n').find((line) => line.startsWith('Row '));
      expect(statement).toBeDefined();
      const [resolved] = locateSpan(result.text, result.segments, statement!);
      expect((resolved as SheetRowLocator).cellRange).toMatch(/^[A-Z]+\d+(:[A-Z]+\d+)?$/);
    });
  }
});

describe('the truncation cases', () => {
  for (const testCase of cases.filter((entry) => entry.caseId.includes('x005'))) {
    it(`${testCase.caseId}: reports what it did not read, and says nothing about it in the text`, async () => {
      const bytes = await readFile(path.join(testCase.dir, testCase.sourceFile));
      const result = await readDocument(bytes, testCase.read);

      expect(result.report.outcome).toBe('truncated');
      expect(result.report.reasonCode).toBe('row_cap_sheet');
      const [sheet] = result.report.sheets;
      expect(sheet?.rowsRead).toBe(4);
      expect(sheet?.rowsTotal).toBe(24);
      expect(sheet?.truncated).toBe(true);
      // The notice is for the person, never for the extractor: a sentence about
      // unread rows inside the text would be remembered as a fact.
      expect(result.text).not.toMatch(/not read|truncat|skraćen/i);
    });
  }
});
