# The reading layer

*How bytes become text the pipeline can extract from. V2.1 item 4.1, native-format
half. Read this before adding a format, changing an extractor, or touching upload
validation.*

Cogeto's promise starts before extraction: a fact can only be verified against a
span if something read that span correctly in the first place. This layer is where
a PDF, a Word document, a workbook or a delimited text file becomes text plus the
provenance to point back at it.

The rule that governs the whole thing: **a format Cogeto can read is a registered
reader, never a branch in a switch.** Everything below follows from that.

## The reader contract

A reader (`project/src/files/reading/reader.ts`) declares five things and
implements one method:

| Declaration | What it decides |
| --- | --- |
| `format` | `pdf`, `docx`, `xlsx`, `csv` |
| `contentTypes` | the declared MIME types it claims |
| `extensions` | the file extensions it claims, as HINTS |
| `detectable` | whether its bytes carry a signature (see selection) |
| `input` | whether it works from the raw bytes or from a stream |
| `granularity` | the finest provenance it can produce for a span |

`read(input)` returns **text, segments and a report**. Nothing else. The reader
does not enqueue, does not write memories, and does not know what a memory is.

## Selection: the bytes decide

Selection is by **detected content type, with the extension as a hint, never by
extension alone** (`reading/sniff.ts`, `reading/registry.ts`):

1. **Magic bytes first.** `%PDF` is a PDF. `PK` is not enough: DOCX and XLSX are
   both ZIP containers, so the sniff walks the ZIP central directory and looks for
   `word/document.xml` or `xl/workbook.xml`. Nothing is inflated, so a zip bomb
   costs nothing here.
2. **A recognisable format we do not support is named as such.** An OLE2 compound
   file (a pre-2007 `.doc` or `.xls`) is detected and refused with
   `legacy_office_format`, which tells a user what to do; "unsupported file type"
   does not.
3. **The declared type and the extension only speak when the bytes do not.** Text
   formats have no signature, which is why CSV is selected this way and why it is
   the only `detectable: false` reader.
4. **A mislabelled file is routed or refused, never trusted.** A workbook uploaded
   as a document is read as a workbook. A CSV named `.pdf` is refused as
   `unsupported_format`, because we know what a PDF looks like and this is not one.

The upload boundary applies the same rule (`files.service.ts`): the sniffed type
wins, and the extension only resolves the CSV aliases browsers really send
(`application/vnd.ms-excel` for a `.csv` on Windows, `application/octet-stream`).

## Provenance: a locator, not a sentence

A reader emits `segments`: half-open character ranges of the text it produced, each
carrying a **structured locator** (`reading/locator.ts`), never a free-text string.

| Granularity | Locator | Produced by |
| --- | --- | --- |
| `page` | page number | PDF |
| `paragraph` | paragraph index | DOCX |
| `sheet_row` | sheet name, sheet index, row, A1 cell range, columns | XLSX, CSV |

`locateSpan(text, segments, span)` resolves a verified span back to the locators it
covers, with one tolerance (whitespace-relaxed matching, for a model that re-wrapped
its quote) and no guessing: **a span that cannot be found returns nothing.** An empty
result is the correct answer to "we cannot say where this came from", and the surface
must say that rather than pick the first page.

The pipeline contract is unchanged: a `SourceItem` still carries `content: string`,
and extraction, verification, statuses and provenance are untouched. The locators
exist now because V2.2 (source detail) and V2.3 (the findings report) render them,
and defining the shape after those surfaces exist would mean parsing a string back
into what this layer already knew.

## PDF and DOCX

Moved behind the seam unchanged. Same parsers (`pdf-parse`, `mammoth`), same
per-page join, same whitespace normalization, **byte-identical text**. The golden set
is scored on that text and the eval cache is keyed on it, so "unchanged" is not a
claim: `reading.spec.ts` runs the pre-seam implementation, copied verbatim, against
the reader over the same fixtures.

The normalization now runs through a scanner that also reports where every input
offset landed (`reading/normalize.ts`), which is what lets page and paragraph
boundaries survive into locators. `normalize.spec.ts` asserts the scanner agrees with
the original regex chain over every four-atom whitespace permutation.

## Spreadsheets

A spreadsheet is not prose, and dumping cells produces garbage facts. The judgment
lives in `reading/table.ts` and is shared by both spreadsheet readers.

**A row carries its column context.** `Supplier: Adriatic Foods; Payment terms
(days): 30` extracts as a fact; `Adriatic Foods, 30` extracts as nothing, or as
something invented. The column names are repeated on **every** row rather than
stated once at the top, because chunking splits by length and a header stranded in
chunk 1 gives no context to chunk 2.

**The header is found, not assumed.** Real sheets open with a merged report title, a
"prepared by" line, a blank row, and only then the header. Rows far narrower than the
table, and rows whose every column says the same thing (a merged banner), become the
sheet's **context line**; the first table-width row of labels is the header. A sheet
that is data from row 1 gets positional column names and keeps its first row as data,
because guessing a header there deletes a record.

**Nothing decorative is emitted.** Empty rows, separator rows (`---`, `===`) and
headers repeated after a page break are skipped rather than turned into statements
that say nothing. Row numbering is the sheet's own, so skipping never shifts a
locator.

**Merged cells** resolve to their master's value across every column they span, which
is what merging meant. Merged header groups get disambiguated labels (`Region (B)`).

**Formulas contribute their computed value, never their text.** The cached value is
what a human saw and what a fact can be verified against; `SUM(C3:C4)` is a recipe. A
formula with no cached result, or a cached error, contributes **nothing** to the
statement and is recorded on the read report by its cell reference, so "we could not
read C5" stays a visible fact about the read instead of a silent gap.

### CSV specifics

- **Encoding**, in order: a byte-order mark decides; otherwise strict UTF-8 (valid
  UTF-8 is not a coincidence); otherwise the configured fallback,
  `COGETO_PARSE_CSV_FALLBACK_ENCODING`, default **windows-1250**. Nothing in the
  bytes can say which legacy codepage they use, so the fallback is a documented
  guess: Croatian is the non-English corpus language and 1250 is the codepage that
  carries č, ć, ž, š and đ. It only affects bytes at or above 0x80, so English files
  are untouched. The encoding actually used is on the read report.
- **Delimiter**: comma, semicolon, tab or pipe, whichever splits the sampled lines
  into the most consistent field count, counted outside quoted regions so a comma in
  `"Zagreb, Croatia"` cannot outvote the real separator. No signal falls back to the
  comma. Semicolon matters in practice: it is what a Croatian or German Excel writes.
- **Quoted fields with embedded newlines** stay one row, and the locator's row number
  is the record number, which is the row a spreadsheet program shows.
- **No header row** is a supported shape, not an error.

## Caps, and saying so

| Cap | Default | Env |
| --- | --- | --- |
| Rows per sheet | 5000 | `COGETO_PARSE_MAX_SHEET_ROWS` |
| Rows per file | 20000 | `COGETO_PARSE_MAX_FILE_ROWS` |
| Text characters | 1000000 | `COGETO_PARSE_MAX_TEXT_CHARS` |
| Parse wall clock | 30s | `COGETO_PARSE_TIMEOUT_SECONDS` |

A fifty-thousand-row export must not become fifty thousand extraction calls. But a
cap that nobody is told about is worse than a small cap: the user believes they got
the whole file. So **truncation is recorded and shown**, per sheet, as rows read out
of rows present.

Nothing about truncation is written **into** the text. A sentence saying "20 further
rows were not read" is a sentence the extractor would happily turn into a fact and
remember as one. The notice goes on the read report, which is rendered for a person
and never sent to a model.

## The read report

`file_read_report` (migration 0041, owned by `files`) holds what the reading layer
made of one file, keyed by object key:

| `outcome` | Means |
| --- | --- |
| `read` | read in full |
| `truncated` | read in part, with per-sheet counts |
| `empty` | no readable text (the scanned-PDF case the OCR half picks up) |
| `unsupported_format` | Cogeto does not read this kind of file |
| `read_failed` | Cogeto reads this kind of file and could not read this one |

The last two are kept apart deliberately: they are different facts about the world
and lead a user to different actions. `reason_code` names the specific case and the
SPA maps it to translated copy through an explicit value → key map, so no English
sentence travels from the server into the interface.

Three properties worth knowing before changing it:

- **Written on its own connection**, outside the pipeline transaction. The reason a
  failed read needs recording is that the job then throws; a row written inside that
  transaction would roll back with the failure it exists to explain.
- **Keyed by object key, not by `file_metadata`.** Extract-and-discard uploads have
  no metadata row at all, and they are exactly the uploads whose original is gone, so
  this row can be the only surviving account of what was read.
- **In the deletion cascade.** Sheet names are the document's own words, so `files`
  implements memory's `DerivedCascade` and the saga erases the row with its source,
  counting it in the receipt as `file_read_reports_removed`.

The file's `error` state still comes from the queue's dead-letter ledger exactly as
before. The report is what turns that state into an explanation.

## Tests

| File | Proves |
| --- | --- |
| `reading/normalize.spec.ts` | the scanner and the original regex chain agree, exhaustively |
| `reading/reading.spec.ts` | PDF and DOCX text is byte-identical to the pre-seam implementation; selection, refusal and cap behaviour |
| `reading/spreadsheet.spec.ts` | header detection, title blocks, merges, formulas, caps, CSV encoding and delimiter |
| `reading/golden-fixtures.spec.ts` | the golden corpus text is still what the reader produces, and every statement has a valid A1 locator |
| `files/files.integration.spec.ts` | the spreadsheet path through the real pipeline, the recorded failure reason, the truncation notice, and the deletion cascade |

Golden cases live in `project/eval/golden/{en,hr}/*-x00*`: five scenarios per
language (clean sheet, title block, multi-sheet workbook, semicolon CSV in a Windows
encoding, and a read truncated at the cap). Each holds the real `source.xlsx` or
`source.csv`, the `read.json` options it is read under, and the `source.txt` the eval
harness scores. Regenerate the text with
`node scripts/dev/build-spreadsheet-fixtures.mjs` after a deliberate reader change,
and refresh the eval cache in the same change, because the extraction input moved.

## What comes next

The OCR and vision half of V2.1 item 4.1 plugs in here as two more registered
readers: a scanned or image-only PDF currently reports `empty` / `no_text`, which is
the honest label this half introduced and the exact hook the next one replaces.
