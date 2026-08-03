#!/usr/bin/env node
// build-spreadsheet-fixtures.mjs — (re)generate the golden set's spreadsheet
// fixtures and the reader output scored against them (V2.1 item 4.1).
//
// Each spreadsheet golden case holds three things:
//
//   source.xlsx / source.csv  the real file, byte for byte what a user uploads
//   read.json                 the reader options the case is read under
//   source.txt                what the reading layer produced from them
//
// The eval harness scores `source.txt`, exactly as it scores every other case;
// `files/reading/golden-fixtures.spec.ts` asserts that reading `source.xlsx`
// under `read.json` still produces that `source.txt`, so the corpus and the
// reader cannot drift apart silently. Change the reader deliberately and this
// script is how you refresh the text (then refresh the eval cache, because the
// extraction input changed).
//
// Usage:
//   npm run build -w @cogeto/shared -w @cogeto/server   # the reader must be built
//   node scripts/dev/build-spreadsheet-fixtures.mjs
//
// The labels in expected.json are hand-written and are NEVER touched here.

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const goldenDir = path.join(repoRoot, 'project/eval/golden');
const { readDocument } = await import(
  path.join(repoRoot, 'project/src/dist/files/reading/registry.js')
);

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_TYPE = 'text/csv';

/** A workbook fixture: sheets of rows, with optional merges. */
async function xlsx(sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    sheet.rows.forEach((cells, rowIndex) => {
      cells.forEach((value, columnIndex) => {
        if (value === null || value === undefined) return;
        worksheet.getRow(rowIndex + 1).getCell(columnIndex + 1).value = value;
      });
    });
    for (const merge of sheet.merges ?? []) worksheet.mergeCells(merge);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Rows 1..count of an invoice ledger, for the truncation case. */
function invoiceRows(labels, count) {
  const rows = [labels.header];
  for (let i = 1; i <= count; i += 1) {
    rows.push([
      `${labels.prefix}-${2000 + i}`,
      labels.customers[i % labels.customers.length],
      1000 + i * 25,
      `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
    ]);
  }
  return rows;
}

const cases = [
  // ── 1. a clean tabular sheet ────────────────────────────────────────────
  {
    dir: 'en/en-x001-sheet-supplier-terms',
    file: 'source.xlsx',
    read: { declaredContentType: XLSX_TYPE, filename: 'supplier-terms.xlsx' },
    build: () =>
      xlsx([
        {
          name: 'Supplier terms',
          rows: [
            ['Supplier', 'Country', 'Payment terms (days)', 'Contract ends'],
            ['Adriatic Foods', 'Croatia', 30, '2027-03-31'],
            ['Nordic Packaging', 'Sweden', 45, '2026-12-31'],
          ],
        },
      ]),
  },
  {
    dir: 'hr/hr-x001-sheet-uvjeti-placanja',
    file: 'source.xlsx',
    read: { declaredContentType: XLSX_TYPE, filename: 'uvjeti-placanja.xlsx' },
    build: () =>
      xlsx([
        {
          name: 'Uvjeti plaćanja',
          rows: [
            ['Dobavljač', 'Država', 'Rok plaćanja (dana)', 'Ugovor istječe'],
            ['Jadranska hrana', 'Hrvatska', 30, '2027-03-31'],
            ['Nordijska ambalaža', 'Švedska', 45, '2026-12-31'],
          ],
        },
      ]),
  },

  // ── 2. a title block above the header ───────────────────────────────────
  {
    dir: 'en/en-x002-sheet-title-block',
    file: 'source.xlsx',
    read: { declaredContentType: XLSX_TYPE, filename: 'delivery-commitments.xlsx' },
    build: () =>
      xlsx([
        {
          name: 'Commitments',
          rows: [
            ['Delivery commitments, Q3 2026', null, null, null],
            ['Prepared by Ana Kovač, 1 July 2026', null, null, null],
            [null, null, null, null],
            ['Project', 'Owner', 'Milestone', 'Due date'],
            [
              'CRM migration',
              'Ana Kovač',
              'Migration plan delivered to Adriatic Foods',
              '2026-08-15',
            ],
            ['Warehouse rollout', 'Marko Babić', 'Pilot site live', '2026-09-30'],
          ],
          merges: ['A1:D1'],
        },
      ]),
  },
  {
    dir: 'hr/hr-x002-sheet-zaglavlje-iznad',
    file: 'source.xlsx',
    read: { declaredContentType: XLSX_TYPE, filename: 'obveze-isporuke.xlsx' },
    build: () =>
      xlsx([
        {
          name: 'Obveze',
          rows: [
            ['Obveze isporuke, Q3 2026.', null, null, null],
            ['Pripremila Ana Kovač, 1. srpnja 2026.', null, null, null],
            [null, null, null, null],
            ['Projekt', 'Nositelj', 'Isporuka', 'Rok'],
            [
              'Migracija CRM-a',
              'Ana Kovač',
              'Plan migracije predan tvrtki Jadranska hrana',
              '2026-08-15',
            ],
            ['Uvođenje skladišta', 'Marko Babić', 'Pilot lokacija u radu', '2026-09-30'],
          ],
          merges: ['A1:D1'],
        },
      ]),
  },

  // ── 3. a multi-sheet workbook ───────────────────────────────────────────
  {
    dir: 'en/en-x003-workbook-multi-sheet',
    file: 'source.xlsx',
    read: { declaredContentType: XLSX_TYPE, filename: 'vendors.xlsx' },
    build: () =>
      xlsx([
        {
          name: 'Vendors',
          rows: [
            ['Vendor', 'Category', 'Contact'],
            ['Adriatic Foods', 'Ingredients', 'Petra Novak'],
            ['Nordic Packaging', 'Packaging', 'Björn Nordström'],
          ],
        },
        {
          name: 'Renewals',
          rows: [
            ['Vendor', 'Renewal date', 'Notice period (days)'],
            ['Adriatic Foods', '2027-03-31', 60],
            ['Nordic Packaging', '2026-12-31', 90],
          ],
        },
      ]),
  },
  {
    dir: 'hr/hr-x003-radna-knjiga-vise-listova',
    file: 'source.xlsx',
    read: { declaredContentType: XLSX_TYPE, filename: 'dobavljaci.xlsx' },
    build: () =>
      xlsx([
        {
          name: 'Dobavljači',
          rows: [
            ['Dobavljač', 'Kategorija', 'Kontakt'],
            ['Jadranska hrana', 'Sirovine', 'Petra Novak'],
            ['Nordijska ambalaža', 'Ambalaža', 'Björn Nordström'],
          ],
        },
        {
          name: 'Obnove',
          rows: [
            ['Dobavljač', 'Datum obnove', 'Otkazni rok (dana)'],
            ['Jadranska hrana', '2027-03-31', 60],
            ['Nordijska ambalaža', '2026-12-31', 90],
          ],
        },
      ]),
  },

  // ── 4. a CSV with a semicolon delimiter and a Windows encoding ──────────
  {
    dir: 'en/en-x004-csv-semicolon-windows',
    file: 'source.csv',
    read: { declaredContentType: CSV_TYPE, filename: 'contacts.csv' },
    build: () =>
      iconv.encode(
        [
          'Supplier;Contact;Escalation contact;Amount due EUR',
          'Nordic Packaging;Björn Nordström;Anna Lindqvist;18400',
          'Alpine Logistics;Émile Rousseau;Claire Dubois;9600',
          '',
        ].join('\r\n'),
        'windows-1252',
      ),
  },
  {
    dir: 'hr/hr-x004-csv-tocka-zarez-windows',
    file: 'source.csv',
    read: { declaredContentType: CSV_TYPE, filename: 'kontakti.csv' },
    build: () =>
      iconv.encode(
        [
          'Dobavljač;Kontakt;Kontakt za eskalaciju;Dugovanje EUR',
          'Jadranska hrana;Željka Perić;Ivan Šarić;18400',
          'Nordijska ambalaža;Božidar Kovačić;Ana Đurić;9600',
          '',
        ].join('\r\n'),
        'windows-1250',
      ),
  },

  // ── 5. a sheet that must truncate at the cap ────────────────────────────
  {
    dir: 'en/en-x005-sheet-row-cap',
    file: 'source.xlsx',
    read: {
      declaredContentType: XLSX_TYPE,
      filename: 'invoices.xlsx',
      caps: { maxSheetRows: 4 },
    },
    build: () =>
      xlsx([
        {
          name: 'Invoices',
          rows: invoiceRows(
            {
              header: ['Invoice', 'Customer', 'Amount EUR', 'Due date'],
              prefix: 'INV',
              customers: ['Adriatic Foods', 'Nordic Packaging', 'Alpine Logistics'],
            },
            24,
          ),
        },
      ]),
  },
  {
    dir: 'hr/hr-x005-sheet-ogranicenje-redaka',
    file: 'source.xlsx',
    read: {
      declaredContentType: XLSX_TYPE,
      filename: 'racuni.xlsx',
      caps: { maxSheetRows: 4 },
    },
    build: () =>
      xlsx([
        {
          name: 'Računi',
          rows: invoiceRows(
            {
              header: ['Račun', 'Kupac', 'Iznos EUR', 'Dospijeće'],
              prefix: 'RN',
              customers: ['Jadranska hrana', 'Nordijska ambalaža', 'Alpska logistika'],
            },
            24,
          ),
        },
      ]),
  },
];

for (const testCase of cases) {
  const base = path.join(goldenDir, testCase.dir);
  await mkdir(base, { recursive: true });
  const bytes = await testCase.build();
  await writeFile(path.join(base, testCase.file), bytes);
  await writeFile(path.join(base, 'read.json'), `${JSON.stringify(testCase.read, null, 2)}\n`);
  const result = await readDocument(bytes, testCase.read);
  await writeFile(path.join(base, 'source.txt'), `${result.text}\n`);
  console.log(
    `${testCase.dir}: ${result.report.outcome}` +
      `${result.report.reasonCode ? ` (${result.report.reasonCode})` : ''}, ` +
      `${result.report.segments} segments`,
  );
}
console.log(`\n${cases.length} spreadsheet fixtures written under project/eval/golden/.`);
