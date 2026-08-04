# Source-context anchoring: what a document is about

**V2.1 item 4.2, spec 1.5. Owned by `ingestion`; migration 0043; prompt
families `anchoring/v0001` and `extraction/v0005`.**

A document states its subject once, in a title block, and then talks about it
generically for forty pages. Before anchoring, a chunk saying only "Device has
one antenna" extracted as a fact about "device": true, retrievable, and almost
useless, because the one thing that made it valuable, WHICH device, was
written far away from the chunk. Two same-boilerplate datasheets for different
models were worse than useless: their facts embedded identically, so
deduplication wanted to merge them and contradiction detection wanted to flag
them, and both would have been wrong.

## The anchor call

Before chunking, one cheap pipeline-tier call reads the document's OPENING
(the first pages, title block, headers) plus its filename and produces the
source context: the subject entities the document is about, its document class
(datasheet, specification, manual, contract), and its revision, each marked
confident or uncertain. The prompt is a versioned artifact
(`anchoring/v0001`); the opening arrives inside the untrusted-data fence with
the same discipline as extraction, and the answer is sanitized to single-line
values, because context values travel into a later prompt and a newline inside
one would be a place to smuggle framing.

File sources only for now: notes, chat, email bodies and web pages state
their subjects inline; documents are where the subject was written once and
far away. The stored row is generic (`source_context`, keyed by source type
and id), so the sources that follow need a row, not a migration.

## Injection: fenced, and only when it says something

The context is injected into every chunk's extraction call as a `DOCUMENT
CONTEXT` block. Two rules with teeth:

- **It is fenced.** The context derives from the document's own words, read by
  a model. Injected outside the fence it would be a laundered second path
  around it: plant an instruction the anchor copies into a "subject", and it
  arrives outside the markers. Same boundary id, same fence, and the
  `DOCUMENT CONTEXT:` label joins the forged-framing and metadata-label
  guards.
- **An empty context renders nothing.** No subjects, no class, no revision
  means the input is byte-identical to the pre-anchoring shape, which is also
  what a missing anchor stage, a failed anchor call, and a non-file source
  produce. Spec 1.5.2 is structural: anchoring can only reduce ambiguity,
  never invent it, and its failure mode is exactly yesterday's behaviour.

The extraction prompt (`extraction/v0005`) resolves subjects in this order: a
subject the fact's own text names always wins; then the nearest section
heading naming one of the document's subjects (spec 1.5.1, the multi-model
datasheet case); then the single confident document subject for facts whose
text is generic; and null when the text supports none, exactly as before.
Uncertain subjects are background, never a default. The anchored subject feeds
`subject_entity` only, never the `entities` arrays, because the dedup
candidate gate scores entity overlap and a document-wide constant entity would
over-merge intra-document pairs.

## Stored, visible, editable, and re-anchorable

The context is stored on `source_context` (content-bearing: subjects and
revision are the document's own words, so the row joins the deletion cascade
and the receipt counts it under `source_contexts`). The source drawer shows it
beside the read report, marked "detected automatically" or "corrected by you".

Editing it (spec 1.5.3) marks the row user-edited, after which the anchor call
never overwrites it, structurally: the stage returns the stored row before the
model is ever asked. Re-anchoring is the existing reprocess action: re-running
the pipeline extracts with the corrected context, and the reconcile stage's
same-batch exclusion (V2.1 item 4.1) makes the re-read's facts merge with or
supersede the old ones rather than duplicate them. No second supersession
engine, one reconcile path.

## How it is measured

File-typed golden cases run the real chain, anchor then extraction, through
the same cached-fixture gate as everything else. The plan-named cases:

- `en-a001` / `hr-a001`: one multi-model datasheet each, generic section
  bodies; per-section `subject_entity` assertions are exact, under the
  zero-tolerance `subject_mismatches` gate.
- `en-r015` / `hr-r014` (dedup): identical boilerplate from two datasheets
  must not merge across anchored subjects.
- `en-r016` / `hr-r015` (contradiction): two models' differing values are
  compatible, not contradictory.

The gate record is in [`docs/eval/gate-model.md`](../eval/gate-model.md); the
dedicated published anchoring metric is item 6.4's, where the plan puts it.

## Tests

- `ingestion/pipeline/anchor.spec.ts`: the anchor input and sanitization, the
  file-only and user-edited-wins rules, degrade-to-null on failure, the fenced
  injection block, the byte-identical empty rendering, the guard additions.
- `ingestion/pipeline.integration.spec.ts` (`source_context anchoring` block):
  anchor call, stored row, injection into extraction, user-edited reuse with
  zero model calls, failure degradation with a successful run.
- `entrypoints/boundary-contract.spec.ts`: `source_context` pinned to
  `ingestion`.
