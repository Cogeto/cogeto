# The findings report: the artifact the wedge is built on

**V2.3 item 6.2. Owned by `reports/` (migration 0049). The published format
contract lives in [`docs/findings-report-schema/`](../findings-report-schema/README.md).**

A findings report is a signed, printable document a quality lead or auditor
can forward and act on without ever opening Cogeto: every contradiction with
both claims quoted verbatim and located, the corpus history behind the
current state, what Cogeto declined to trust, and what it could not read. It
is the primary sales artifact and the primary trust artifact at once, and the
one rule that governs everything below is: **every number, claim, and span
traces to stored truth, and the report is honest about its own limits.**

## The findings run (issue A)

A report is generated from a **run** over a stated scope: the whole corpus,
one import, an explicit set of sources, or a date range. Runs are rows on the
`findings_report` ledger: scope, requester, when, the model configuration in
force, the counts produced, integrity metadata, and pointers to the two
rendered artifacts. Principal-gated and listable like everything else
(`/api/reports`); generation is a worker job (`report.generate`) with
progress upserted outside the job transaction (the `ingestion_progress`
precedent), because a large corpus takes time.

**Delta.** The run records `previous_report_id`: the latest earlier run over
the SAME scope (matched on the canonical serialization of the scope, so key
order can never split identical scopes). Findings resolved, newly appeared
and reopened since that run are computed from the findings lifecycle's event
log (`memory_relation_event`, item 6.1), never reconstructed. Where no
previous run exists, the report says so instead of showing zeros that imply
nothing changed.

## Content and structure (issue B)

The document is designed for a reader who has never used Cogeto, in this
order: report provenance (identifier, scope, model configuration, and the
**published trust scores for that configuration**), an executive summary,
**coverage and limits before any finding**, the findings, superseded facts
with their chains, the withheld (suppressed-fact) summary, and the
verification procedure.

- **Trust scores** are read from the bundled `eval/trust-scores` artifacts by
  exact configuration id (accepting the probed `--reasoning` variant). No
  match means the report SAYS no published measurement exists for this
  configuration; measured accuracy is never borrowed from another one.
- **Findings are grouped by subject entity**: a conflict is about a subject,
  not owned by either document, so all evidence about one question lands
  together; groups sort alphabetically and findings by detection time, so two
  runs over the same data are comparable. Each finding carries both claims,
  both verbatim spans with document name, revision (from the anchoring
  context) and precise location (the reader-seam locators), the detection
  date and pass, the lifecycle state, the resolving revision where one
  resolved it, and the event history.
- A span recovered by **OCR or a vision model says so on the finding** (the
  locator's recorded tier), because the transcription's reliability is part
  of the evidence.
- **Sensitive facts are withheld** from the forwardable artifact and counted
  (`sensitive_facts_excluded`): a report is built to leave the instance.
- Every bound is stated in the payload (`scope_limit`/`scope_truncated`,
  `chains_limit`, `entries_limit`): no silent truncation anywhere.

## Rendering and formats (issue C)

One payload produces both formats, so they cannot diverge. The **JSON** is
the signed record, with a published, versioned schema and a fictional sample
(`docs/findings-report-schema/1.0/`), drift-guarded by a spec test against
the in-code zod authority. The **PDF** is a dependency-free renderer inside
the module (the ZIP-walk precedent): a hand-rolled deterministic PDF writer
(`node:zlib` for compression), the vendored DejaVu Sans faces
(`project/fonts/`, license alongside, full glyph coverage for the four
interface languages) embedded as CIDFontType2 with a ToUnicode map so quoted
evidence survives copy and paste, and the canonical logo drawn as vector
paths from the provided brand file, never redrawn or restyled.

Document rules: A4, restrained typography, no decorative colour, tables that
survive page breaks with their header repeated, quoted spans in an indented
panel with a left rule (distinct in black-and-white print), page numbers, a
table of contents, and a footer carrying the report identifier and generation
date. Long spans truncate VISIBLY in the PDF with a note that the JSON holds
the full text. Every string is a key in the server `report` namespace,
present in all four locales; dates and numbers format per the report's
locale, which is the owner's preferred language (the anchor rule). Quoted
spans stay verbatim in their original language whatever the report language,
and the coverage section says so.

## Signing, verification, lifecycle (issue D)

The worker signs the sha256 of the canonicalized payload with the instance
ed25519 key: exactly the deletion-receipt convention, so one documented
procedure covers receipts, passports and reports. Both formats carry the
identifier, the hash, the signature, and the public key (the PDF prints the
fingerprint plus the four-step procedure with runnable commands; the JSON
embeds the PEM). The end-to-end procedure with `jq` + `openssl` is published
in the schema README and verified in CI by
`report_sign_verify_roundtrip`.

**Deletion coverage.** A rendered report quotes verbatim spans, so it is the
second content-bearing derived artifact after the passport and is covered
identically (`FindingsReportCascade`): any deletion by the owner expires
their in-flight and ready runs inside the enumeration transaction,
unconditional rather than content-scoped (the passport's decision 0061
rationale), both artifacts' object keys join the receipt
(`findings_reports_expired` count), the worker leg erases the bytes, the
sweep verifies them absent, downloads refuse with the reason, and the
`markReady` status guard closes the SEC-8 mid-assembly race. The RUN ROW
survives as `expired` for the delta view: it carries scope, counts and
integrity metadata, never quoted content.

**Audit.** `report.requested` (user), `report.ready` (worker),
`report.downloaded` (the presign moment: a signed egress of corpus content
leaves a trace), `report.expired` (deletion saga). Structural detail only.

**Retention.** Rendered artifacts live 24 hours (the passport retention
decision applied consistently: the artifact is built to be forwarded, the
instance copy is a staging area, and a short window bounds what the deletion
cascade must chase), swept hourly by `report_retention`. Regeneration is one
click; run records are permanent.

## What is deliberately out

- No model call anywhere in generation: the report is computed from stored
  rows, never summarized by a model that could embellish it.
- No severity scale: none is genuinely derivable, and inventing one would be
  exactly the confident-sounding decoration the product exists to refute.
- No PDF byte-signing: the JSON is the signed record and the PDF a faithful
  rendering carrying the same values; signing rendered bytes would tie the
  signature to layout instead of content.
