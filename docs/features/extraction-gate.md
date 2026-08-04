# The extraction gate: admission control before model spend

**V2.1 item 4.3, spec 1.6 and 1.7. Owned by `ingestion`; migration 0042.**

Extraction is admission controlled per source and per connector. Before this,
the only controls over what entered the corpus were global caps and one
hardcoded registry budget; the day bulk import (V2.2 item 5.3) or an observed
connector (V2.4 item 8.x) arrives, one bad folder would flood the corpus at
full model cost. The gate closes that in advance, and it is the analogue of the
first-person rule: a cheap deterministic per-source predicate, applied at
exactly one chokepoint, never a model judgment. Where the first-person rule
filters at the read ("is this obligation mine?"), the gate filters one stage
earlier ("should this be extracted at all?"), because the failure mode here is
cost and corpus flooding rather than a false claim.

## What an owner can control

Per source kind (the registry's extraction-capable types: notes, chat, email,
files, web), each defaulting to today's behaviour when unset:

- **Enable or disable extraction.** The source itself is always stored; the
  gate controls extraction, never capture.
- **A fact budget.** Joins the existing minimum: the tightest of the global
  parse cap, the source-type registry's budget and the owner's number wins.
- **Retention in days.** Facts from that kind whose extractor resolved no
  validity of their own get `valid_until = admission + N days`. A fact's own
  stated validity always outranks the blanket policy. Lapse is then the
  dreaming staleness pass's existing job (`active` becomes `outdated`); nothing
  is deleted, history is never destroyed, supersession semantics are untouched.
- **Admission rules**, allow or deny rows per dimension:
  - `document_class` binds to the reading layer's detected format (`pdf`,
    `docx`, `xlsx`, `csv`, `image`): what the bytes are, never what the label
    claims. Deny blocks a class; any allow rows make the list exclusive, the
    email-allowlist semantics. Sources with no detected class (notes, chat,
    email bodies, web pages) are untouched by class rules. When 4.2 lands,
    anchoring's document class (contract, datasheet, manual) upgrades this
    dimension.
  - `source_id` switches off one document, deny-only: allowing a single id
    would silently disable the rest of its connector, so the API refuses it.
  - `channel` and `folder` are reserved: the table takes them without a
    migration the day connectors and bulk import enforce them, and the API
    refuses them until then, because a control nothing enforces would be a
    control that silently does not control.

Email **sender** admission is deliberately not here: the email allowlist
already owns it, and a second authority would let the two disagree.

## Where it is enforced

One chokepoint: the ingestion pipeline, after the source is read (the decision
needs the owner and the reader-stamped document class) and **before any model
call**. A refused source costs zero extraction, verification, embedding and
reconciliation spend. Reading cost for files (OCR, vision) is still incurred,
bounded by the vision caps; folding the gate into the reading ladder would
cross the module boundary for an optimisation the caps already bound.

A refusal is recorded in `extraction_gate_refusal`, mirroring `email_refusal`:
metadata only (source identifiers, reason, timestamp), never content. A gated
source therefore never looks processed-with-zero-facts, the honesty rule the
reading layer's `file_read_report` established. The ledger is pruned after 30
days by a nightly job and its rows leave with their source through ingestion's
deletion cascade, so no dangling provenance reference outlives a receipt.

An absent gate row is today's behaviour, byte-identical: enabled, registry
budget, no retention. The pipeline treats a missing gate service (bare
harnesses, eval) identically, so the golden-set harness measures exactly what
it measured before.

## The settings surface

Settings gains an "Extraction gate" section, served by ingestion's own
controller (`/api/extraction-gate`), the email-settings precedent: per-kind
enable, budget and retention; file-format rules; and the recent refusals, so a
blocked source is visible where the block was configured. Per-source disable
exists as API and machinery; its UI home is the V2.2 source detail. Every
mutation is audited with structural detail only.

## Spec 1.7: injection defence is satisfied, and by what

The V2 plan wrote that the extraction prompt "lacks injection defence today".
That sentence predates the 2.0 security audit's SEC-4 wave and is no longer
true; 4.3 therefore changes no prompt. The defence, verifiable in the tree:

- Every chunk reaches the extraction prompt fenced by `fenceUntrusted` with a
  per-call random boundary the document's author cannot know
  (`ingestion/pipeline/extract.stage.ts`), and the framing labels stay outside
  the fence.
- Two code-side guards run after the model answers, because a request to a
  model is not a guarantee: a fact grounded only in a forged framing region
  (a document imitating the harness's own vocabulary) is dropped, and a fact
  that grabbed a metadata label as content is dropped.
- The verifier fences the span and its context the same way
  (`ingestion/pipeline/verify.stage.ts`), and golden-set traps exercise the
  forged-framing drop.

## Tests

- `ingestion/persistence/extraction-gate.spec.ts`: the pure gate predicate,
  rule semantics, precedence, the no-rows parity default.
- `ingestion/pipeline.integration.spec.ts` (`extraction_gate` block): refusal
  before any model call with the ledger row; per-source deny; document-class
  deny with the class on the refusal; budget min; retention stamping only on
  facts without their own validity; parity with the gate wired and no rows.
- `entrypoints/boundary-contract.spec.ts`: the three tables and the retention
  job type are pinned to `ingestion`.
