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
| `format` | `pdf`, `docx`, `xlsx`, `csv`, `text` |
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
   formats have no signature, which is why CSV, Markdown and plain text are
   selected this way: they are the `detectable: false` readers. One label gets
   special handling: `text/plain` is what browsers put on ANY textual file, so
   for it the extension speaks first. A `.csv` or `.tsv` declared `text/plain`
   still routes to the CSV reader, and a `.md`, `.markdown` or `.txt` lands on
   the text reader that claims it anyway.
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
| `paragraph` | paragraph index | DOCX, plain text and Markdown |
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

## Plain text and Markdown

The formats a converted page arrives in (V2.5 item 8.2: a Confluence page
uploads as `text/markdown`), read by one registered reader (`text.reader.ts`):

- **Markdown is not parsed.** A heading or a list item stays its literal line.
  The reader's job is text plus paragraph provenance, not rendering, and a
  rendered form would break span verification against what was stored.
- **Paragraphs are blank-line separated blocks** of the normalized text, so a
  hard-wrapped paragraph is one segment. The locator is the shape DOCX emits:
  a 1-based paragraph index over non-empty blocks.
- **Encoding is the CSV ladder, reused**: a byte-order mark decides; otherwise
  strict UTF-8; otherwise the configured fallback
  (`COGETO_PARSE_CSV_FALLBACK_ENCODING`, default windows-1250). The encoding
  used is on the read report.
- **The char cap truncates at a paragraph boundary** and the read report says
  so (`truncated`, `text_over_cap`); nothing about truncation is written into
  the text itself.

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
| `reading/text.spec.ts` | paragraph splitting and locators, selection incl. the preserved CSV alias, encoding fallback, char-cap truncation |
| `reading/golden-fixtures.spec.ts` | the golden corpus text is still what the reader produces, and every statement has a valid A1 locator |
| `files/files.integration.spec.ts` | the spreadsheet path through the real pipeline, the recorded failure reason, the truncation notice, and the deletion cascade |

Golden cases live in `project/eval/golden/{en,hr}/*-x00*`: five scenarios per
language (clean sheet, title block, multi-sheet workbook, semicolon CSV in a Windows
encoding, and a read truncated at the cap). Each holds the real `source.xlsx` or
`source.csv`, the `read.json` options it is read under, and the `source.txt` the eval
harness scores. Regenerate the text with
`node scripts/dev/build-spreadsheet-fixtures.mjs` after a deliberate reader change,
and refresh the eval cache in the same change, because the extraction input moved.

## The ladder: pages that are pictures

A page with no usable text layer used to end the story. It now enters a ladder
that is **deterministic, cheapest-first, decided per page, and spends no model
call on deciding** (`reading/ladder.ts` decides, `reading/page-ladder.ts`
executes, which is what lets every routing rule be tested without a binary or a
model).

| Tier | Runs | Where |
| --- | --- | --- |
| 1 `text` | the page's own text layer, when usable | nothing runs |
| 2 `ocr` | Tesseract, `eng`+`hrv`+`deu` | in the instance, CPU only |
| 3 `vision` | a model that can see | only if configured and probed working |

**Tier one asks whether the text is USABLE, not whether it exists.** That
distinction is the whole reason scanned PDFs read as empty before: a scan
usually carries a text layer of a folio number, ligature soup, or somebody
else's bad OCR baked in, and taking it is how a two-hundred-page contract
reports itself as read.

**Escalation needs something on the page.** Before spending a vision call the
reader renders a 25 DPI gray PGM and counts dark pixels, so a blank separator
sheet costs one cheap render and stops.

### The thresholds, and why they are numbers rather than adjectives

Every one of these was wrong when it was reasoned out and right once it was
measured. The measurements are in the code beside each constant.

| Threshold | Value | Measured |
| --- | --- | --- |
| Picture ink coverage | 0.3% | blank page 0.000, one line of text 0.010 (vector and scanned alike) |
| OCR mean confidence | 70 | clean scan 91.9, screenshot 92.3, poor scan 55.7 |
| Meaningful characters | 20 | `Page 3 of 12` is 12, `Atlas proposal details` is 22 |

The ink threshold started at 2%, reasoned from "a diagram covers whole
percents", which would have discarded every page carrying a single line of text.
The character floor started at 40 and called a real 22-character line furniture.

The confidence threshold exists for a case the text alone cannot catch. A poor
scan reads as `CONIULTING AGREEMENT. KEY OBLIGATIOMS ... Ginsillani, Ara Kavac`:
those tokens have vowels, ordinary length and no impossible consonant runs, so
every dictionary-free quality test passes them. Tesseract knew it was guessing
and nothing else did, so its own confidence decides.

**Tier three transcribes; it does not interpret.** The prompt
(`project/prompts/vision_read/v0001.md`) bans completing patterns, filling in
illegible labels, and contributing knowledge the model has but the page does
not, and makes `[unreadable]` and a nothing-readable sentinel first-class
answers. This matters more than usual: output from tier three becomes the page's
text, and verification then checks claims AGAINST THAT TEXT, so an invented word
cannot be caught downstream. The span verification would check is the invention.

**The tier is recorded on the provenance locator**, because a fact transcribed
from a photograph is weaker evidence than one lifted from a text layer. Facts
are otherwise statused normally: `uncertain` keeps meaning "the verifier judged
it so", and marking every fact from every scan uncertain would empty that status
of the meaning it has.

**Text-layer reads are unchanged.** Without a ladder the PDF reader behaves
exactly as before and no locator gains a tier, so the golden set and the eval
cache are untouched.

## Vision is a probed capability

The only honest answer to "can this instance read images" is to send one.
`probeVision` does that at boot and on the capability registry's schedule. A
GGUF model is multimodal **only when its multimodal projector is loaded** beside
the weights; the same weights serve happily as a text model, and neither the
model name nor `ollama list` shows the difference, so a configuration flag would
be a claim rather than a check.

Failures are classified into reasons that lead somewhere different:

| Reason | Means |
| --- | --- |
| `not_configured` | no vision tier; the ladder stops at OCR, which is supported, not broken |
| `unreachable` | the endpoint did not answer at all |
| `probe_timeout` | it is slow, not broken (see below) |
| `image_rejected` | it answered and refused the IMAGE; on a local runtime this names the projector |
| `unusable_response` | it took the image and returned nothing usable |
| `refused_by_policy` | redaction is on |
| `reasoning_exhausted` | a reasoning model spent its entire output budget thinking, so the answer never started; the fix is a token budget, never the network or the projector (Part B of reasoning support) |

`probe_timeout` is kept apart from `unreachable` deliberately: a remote GPU
warming a vision model takes tens of seconds on its first request, and calling
that unreachable sends an operator to look at the network when the fix is
`COGETO_VISION_PROBE_TIMEOUT_MS`.

**Redaction and vision are mutually exclusive.** Pixels cannot be
pseudonymized, so with redaction enabled a vision call would be the one path
that sends unredacted content to a model. It fails closed, as an unreachable
sidecar does.

## Running the model yourself

`openai` names a **protocol**, not a company. A model you run through llama.cpp,
vLLM or LM Studio speaks it, so `COGETO_PROVIDER_VISION=openai` with
`COGETO_OPENAI_BASE_URL` pointing at your own server is expected configuration.
Two things follow from the endpoint being yours rather than hosted:

- **Per-tier timeouts apply.** They used to be attached only when the provider
  was `ollama`, so a self-hosted OpenAI-compatible endpoint had no client-side
  deadline at all and one slow page could hang a pipeline job indefinitely. They
  now apply to any self-hosted endpoint under the provider-neutral
  `COGETO_MODEL_TIMEOUT_*_MS` names; hosted providers keep no explicit timeout,
  exactly as before.
- **No API key is required.** Your own server often runs with no auth, and
  demanding a meaningless placeholder is friction with no safety in it. The key
  stays required for the hosted `api.openai.com`, where a missing one is a real
  misconfiguration worth refusing at boot.

One constraint: `COGETO_OPENAI_BASE_URL` is a single global for the provider, so
every tier bound to `openai` reaches the same endpoint. Pointing it at your own
server means no tier can use the hosted API at the same time.

This also changes the boundary, and the change is worth stating rather than
leaving to inference. Tiers one and two run in the instance and pages they read
never travel. Tier three is a network call: when the vision tier points at a
machine elsewhere, page images leave the instance to reach it. That is usually
the intent, but "nothing leaves the box" describes the local tiers, not this one.

## Vision caps

| Cap | Default | Env |
| --- | --- | --- |
| Vision pages per document | 20 | `COGETO_VISION_PAGES_PER_DOCUMENT` |
| Vision pages per user per day | 100 | `COGETO_VISION_PAGES_PER_USER_DAILY` |
| Vision probe deadline | 30s | `COGETO_VISION_PROBE_TIMEOUT_MS` |

Hitting a cap **stops escalation and marks the remaining pages honestly**; it
never fails the file. One vision failure ends vision for that document rather
than repeating itself twenty times, because the honest label is identical for
every remaining page and each retry costs minutes.

## Honest failure, and reading again

| `outcome` | Means |
| --- | --- |
| `read` | read in full |
| `truncated` | read in part, with per-sheet counts |
| `empty` | nothing readable, and no capability would have changed that |
| `needs_vision` | pages need a model that can see, which this instance has not |
| `unsupported_format` | Cogeto does not read this kind of file |
| `read_failed` | Cogeto reads this kind of file and could not read this one |

`needs_vision` is a fact about the INSTANCE, not the document, which is why the
retained bytes matter: `POST /api/files/:key/reprocess` reads the source again
through the normal pipeline, and `GET /api/files/awaiting-capability` lists
everything worth re-reading after enabling vision. That endpoint has **no UI
yet**: the Sources list in V2.2 item 5.2 is where it belongs, and building a
bespoke page for it now would be building something 5.2 deletes.

What does have a surface is the moment it matters: an upload that produced
nothing **keeps its row** on the Memories page, with the reason and the re-read
action. The row used to be dropped as soon as the pipeline job succeeded, and a
job succeeds even when the reader produced no text at all, so a scan needing
vision vanished and looked exactly like a document that had been processed. The
row now settles on the read report rather than on the queue's state.

A re-read reconciles rather than duplicates, and making that true required a
real fix: reconciliation used to exclude candidates from the same SOURCE, which
was identical to "the same run" only because a source was ingested exactly once.
Reprocessing separated the two, so the pipeline now excludes the same BATCH and
dreaming keeps the source rule its own work needs.

## What is not gated

The vision path is **not eval-gated in CI**, because gating it needs a vision
model in CI and there is none. The deterministic ladder is fully covered by the
`test` check, including integration tests against the real binaries. The vision
prompt's own behaviour is exercised against a real runtime by hand. Adding a
gate that is permanently skipped would be worse than saying this.
