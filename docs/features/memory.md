# Memory: lifecycle, reconciliation, and time travel

How a fact enters memory, how its status moves, how Cogeto notices that two facts
disagree, and how the past stays readable. This is the core of the product; every
other feature reads through it.

## The row

Every memory carries `owner_id` (NOT NULL), a `scope` enum (`private` | `shared`,
NOT NULL), provenance `source_type` + `source_id` (both NOT NULL, no orphans ever),
a `status`, a `sensitive` boolean, a validity interval, extracted `entities`, an
optional `subject_entity`, and a `kind` (`commitment`, `decision`, `preference`,
`fact`, `open_loop`).

### Six statuses, and one flag beside them

`active` · `outdated` · `contradicted` · `uncertain` · `replaced` · `user_approved`

`sensitive` is a **boolean orthogonal to lifecycle**, not a seventh status. A
sensitive fact can also become outdated; a single enum would have made those
mutually exclusive by construction.

Retrieval rule for `sensitive`: excluded from default retrieval, returned **only to
its owner**, and only on explicit per-query opt-in.

### Why a fact is uncertain: the admission taxonomy

`uncertain` used to be one undifferentiated bucket. Since V2.0 item 3.3 every
uncertain admission carries a named **sub-reason** on `memory.uncertainty_reason`,
because the findings report has to explain each fact rather than label it.

| Sub-reason | What produced it |
|---|---|
| `hedged_in_source` | the verifier supported the claim; the SOURCE stated it tentatively (the extractor's `hedged` flag and its verbatim `hedge_phrase`) |
| `partially_supported` | verifier verdict `partial` |
| `unsupported` | verifier verdict `unsupported` |
| `unjudgeable` | the verifier could not determine support: its batched reply omitted a verdict for the claim, or the cited span could not be located in the source, so a negative verdict is not attributable to the evidence |
| `structurally_invalid` | not admitted at all: a blank claim or a blank span. Never on a memory row, only in the suppressed-fact log |
| `legacy_unspecified` | backfill only (migration 0039): an `uncertain` row predating the taxonomy whose stored verification result does not determine a reason. Never written by new code |

There is deliberately **no low-confidence-extraction reason**: the extractor emits
no confidence signal, so the category would have nothing behind it.

The mapping is **total**, first match wins, and has no default arm:

1. no verdict returned for the claim → `unjudgeable`
2. `supported` and hedged → `hedged_in_source`
3. `supported` and plainly stated → **active**, no reason
4. `partial`: span not locatable → `unjudgeable`, else `partially_supported`
5. `unsupported`: span not locatable → `unjudgeable`, else `unsupported`

Two precedence rules make it readable. **Verifier failure outranks hedging**, so
`hedged_in_source` means exactly "the only thing wrong is that the source was
tentative". And **span locatability is consulted only on a non-`supported`
verdict**, so admission is byte-identical to the rule that preceded the taxonomy:
labelling split the bucket, it did not move the line.

The column is written once, at admission, and never rewritten. It records why the
fact **was** admitted uncertain, which stays true after the status moves on. The
`verification_result` row remains the evidence (verdict, the verifier's wording,
the span, the prompt version); the column is the decision, exactly as `status` is.

### Admission: automatic, and never blocking

**Cogeto resolves its own reviews.** No admission decision requires or awaits a
person. Ingestion never pauses, never enqueues an approval, and never writes a
queue row. There is no manual approval queue for facts.

Facts are **admitted as uncertain with their sub-reason rather than discarded**: an
admitted fact is inspectable in Sources and citable with soft framing, while a
discarded one would exist only in a log. Non-admission is reserved for the one case
where storing would be actively wrong, `structurally_invalid`: a blank claim is a
memory row with no content, and a blank span is a fact with no provenance to
inspect. Both sides of that line write a
[suppressed-fact log](#the-suppressed-fact-log) entry, so nothing is lost either
way.

Note what is deliberately **not** a non-admission case: a span the chunker cannot
locate. Chunking can split a legitimate span across a boundary, so treating an
unmatched span as fabrication would silently lose real facts. It lands
`unjudgeable` instead.

The user can still confirm a fact, and that confirmation still outranks machine
judgment in reconciliation. It moved from a queue to a **contextual action** on the
fact's own drawer, where its evidence is in front of you.

### The suppressed-fact log

`suppressed_fact_log` (ingestion-owned) records every automatic decision that
demoted or withheld a fact: the claim as extracted, its kind, the source and the
exact span, the sub-reason, the verification detail behind it, the timestamp, and
the `memory_id` when the fact was admitted as uncertain (NULL when it was not).
Automatic resolution does not mean invisible resolution.

It is a first-class record, not a debug trail. The V2.2 source detail view lists a
source's entries and the V2.3 findings report summarises them, so the query surface
ships with the write path: `GET /api/suppressed-facts` (by source, by reason, by
date range, paged) and `GET /api/suppressed-facts/summary` (counts per reason,
zeros included).

Two rules it inherits from memories rather than invents:

- **Gating.** `owner_id`, `scope` and `sensitive` are copied from the source, and
  every read applies the identical scope + sensitive predicate memory reads apply.
  An entry is exactly as visible as the fact it explains.
- **Deletion.** Entries are content-bearing, so they go with their source through
  the deletion saga (via ingestion's `DerivedCascade`, over every enumerated source
  including an email's attachments and a conversation's messages) and the receipt
  counts them under `suppressed_facts_removed`.

**Retention is the life of the source.** Entries are the evidence for a decision
about that source: outliving it would mean retaining source content after a signed
receipt said it was erased, and expiring earlier would mean a report that cannot
explain a fact still in memory. There is no scheduled expiry.

### Who may move a status

Transitions are owned by the `Memory` aggregate and nothing else.

- Only reconciliation sets `contradicted`.
- Only the user sets `user_approved`, and only from `uncertain` or `contradicted`.
- Only the consolidation pass (dreaming) sets `outdated` from a lapsed interval.
- `replaced` is terminal and is only ever reached through supersession.
- Only the deletion saga hard-deletes, with one narrow extension below.

**Editing a memory's content is supersession, never mutation.** An edit creates a
new memory (`user_approved`, same provenance, plus an edit audit entry) and marks
the old one `replaced` with `superseded_by` set. History is never destroyed, and
there is no second write path.

**Rejecting an uncertain memory** is the one narrow extension to "only the saga
hard-deletes": it removes the row and its Qdrant point through a guarded path on
the aggregate, audited. A rejected extraction is pipeline noise, not user data with
a source to forget, so a deletion receipt would attest to the wrong thing while the
audit row keeps the removal accountable. It is a per-fact action on the drawer, not
a queue: nothing asks the user to work through a list.

## The gates

Scope and `sensitive` are **hard gates**: WHERE-clause and Qdrant payload
pre-filters inside the query. App-side post-filtering of vector results is
forbidden, because a demoted leak is still a leak.

Statuses are **score multipliers on top of the gates**, never gates themselves.
`replaced` is excluded from default retrieval; temporal queries lift that
exclusion (see below).

The memory module owns every read path, and each primitive requires a `Principal`,
so an unscoped query is unrepresentable in the type system rather than forbidden by
review. Scope changes move the Postgres row and the Qdrant payload together, so a
`shared → private` demote takes effect in vector search the instant it commits.

Search is hybrid: vector similarity, Postgres full-text on the `simple`
configuration over unaccented text (Croatian has no built-in dictionary, and
`simple` + `unaccent` is predictable across languages), and entity matching over a
`text[]` column with a GIN trigram index. Vector scores normalize to [0,1] at the
adapter boundary so fusion has one scale.

## Reconciliation

Stage 6 of the pipeline, and the nightly dreaming cycle in batch: **one service,
two drivers**, so both run inside their job's transaction and neither can drift
from the other.

The calibration stance, binding on everything below:

> A wrong merge destroys a distinct fact, a wrong contradiction wastes the user's
> attention, and both are worse than doing nothing.

Where a rule had a lenient and a conservative reading, the conservative one was
chosen.

### Finding candidates: deterministic, cheap, model-free

No model call happens in candidate generation. Candidates come from committed
memory of the **same owner and same scope**, through the gated primitives, with
rows from the incoming fact's own source excluded. Thresholds live in one versioned
config (`project/src/ingestion/reconcile-config.ts`) and are **calibrated per
embedding model** since V2.3 item 6.1: 0.93 under one model and 0.93 under another
are different claims, and an embedding model with no calibration entry fails
loudly instead of borrowing another model's geometry.

Subject identity is **alias-aware** (`ingestion/domain/entity-match.ts`): case,
punctuation, diacritic and legal-suffix folding; the owner's recorded
`entity_alias` pairs, which is how a Croatian and an English name for one company
pair at all; and a narrow typo rule (one edit, long names, never at a token
start). The candidate pool draws from three searches: the vector top-K, the
entity trigram path, and the **subject path**, which expands the fact's subject
through the alias set, the only search that can surface a cross-language
counterpart.

- **Dedup candidates**: embedding similarity ≥ the calibrated `dedupSimilarity`,
  **or** canonical entity overlap `|A∩B| / min(|A|,|B|)` ≥ 0.8 with identical
  `kind`.
- **Contradiction candidates**: matching subjects (alias-aware), both kinds in
  {fact, decision, preference, commitment}, and a similarity rule that depends
  on how the subjects matched: pairs found by the entity/subject path (no
  vector score) qualify outright; scored pairs need the calibrated floor unless
  the subjects match through a recorded **alias** (cross-language names
  legitimately embed far apart); `contradicted` rows are candidates too, so a
  corrected revision can supersede a finding's party.
- **Escalation**: a pair *above* the dedup threshold reaches the contradiction
  check after ANY non-merge dedup ruling, `distinct` **or** `related`. A
  paraphrased conflict embeds nearly identically and the dedup judge calls it
  `related` as often as `distinct`; before 6.1 only `distinct` escalated, which
  made that shape structurally invisible. A pair that was never dedup-eligible
  (a `contradicted` candidate) escalates directly.

**The judged-pair ledger runs in front of every model call** (`checked_pair`,
V2.3 item 6.1): a pair already judged under the same prompt version and model
configuration keeps its verdict, so the nightly pass cannot flip a borderline
`compatible` days later from sampling variance, and re-examination costs no
tokens. A pair re-opens only when a fact changes (supersession mints a new id),
when the prompt or model configuration changes, or on an explicit re-run.

**Numeric and unit reasoning runs before the judge**
(`ingestion/domain/quantity.ts`): quantities are parsed from both claims (both
decimal conventions), converted within their dimension, and compared with
range, tolerance, approximation and stated-precision handling. A same-slot
conflict with no update language and no temporal ordering IS the verdict, with
no model call; everything the parser cannot decide goes to the judge with the
parsed values appended as a `PARSED QUANTITIES` block
(`reconcile_contradiction/v0002`), so the model compares converted values
rather than doing arithmetic in its head.

At most three **fresh** model confirmations per family per fact (ledger hits are
free), ranked by conflict likelihood rather than raw similarity: a pair whose
quantities already compare as a same-slot conflict outranks everything, so a
crowded topic cannot hide the true conflict behind the first few neighbours.
The first `same_fact` merge stops that fact; at most one contradiction action
per fact per run.

**Timing** (V2.3 item 6.1, issue B): facts admitted by concurrent jobs are
invisible to each other's inline pass, so the pipeline enqueues one delayed
`reconcile.repair` job per source, which re-pairs against whatever committed
meanwhile (the ledger keeps the re-run free). Confirming an `uncertain` fact
fires the memory module's eligibility port, which enqueues the same repair for
that fact immediately, instead of waiting for the nightly cycle. Every finding
records which pass detected it (`detected_by`) and when (`detected_at`),
because a finding surfaced days later by the nightly pass is a different thing
from one caught inline, and the report must say so.

### Merging

Only a `same_fact` verdict merges. `distinct` and `related` change nothing.

Survivor selection is the newer memory by `created_at`, except:

1. the older is `user_approved`, so the older survives (user judgment outranks recency);
2. the newer ranks strictly below the older on `user_approved > active > uncertain`
   (a verified fact never yields to an unverified duplicate of itself);
3. both are `user_approved`, in which case **nothing merges** at all.

The loser becomes `replaced` with `superseded_by` set and its interval closed at the
survivor's start. No row is ever deleted.

**Enrichment** applies only when the dedup prompt returns a `merged_content` that
differs from the survivor's text and the survivor is not `user_approved`: the
survivor is superseded by an enriched successor carrying the union of both entity
sets, and the loser points at that successor. Otherwise the merge is the pointer
alone.

### The `user_approved` shield

Reconciliation never transitions, supersedes, merges, or enriches a `user_approved`
memory, with exactly one exception: pairing it into a `contradicts` relation, which
records its prior status so resolution can restore it. The user is the only one who
resolves against their own confirmations.

### Contradictions

Detected pairs become `memory_relation` rows. Convention: **a** is the incoming
(newer) fact, **b** the existing one, with a unique index on the canonical pair.

**A relation row permanently excludes its pair from re-detection, resolved or not.
Dismissed stays dismissed**: the user has already ruled the pair compatible, and
reconciliation never asks again.

Since V2.3 item 6.1 a finding has a **lifecycle**
([`docs/features/findings.md`](findings.md)): open, resolved by user, resolved
by revision, reopened, with an append-only event log
(`memory_relation_event`) the report's delta view renders. A supersession that
genuinely settles the conflict resolves the finding automatically with the
cause recorded (the source revision link included, where one exists); a
persisting conflict follows the successor as the SAME finding; a reintroduced
conflict REOPENS the original with its history rather than minting a new one.
Resolved findings disappear from everything presented as current and stay
queryable with their history.

The three resolutions are owner-only, single-transaction, and audited:

- **Confirm A or B.** The confirmed memory goes `contradicted → user_approved`. The
  loser goes to `outdated` if its own interval had already closed before the
  confirmed fact began (it was true and expired on its own, nothing replaced it), or
  otherwise to `replaced` pointing at the confirmed winner.
- **Correct both.** Routes to the edit-as-supersession flow per memory; each is
  superseded by a `user_approved` successor in the same transaction.
- **Dismiss.** Each memory still in `contradicted` is restored to the status
  recorded at detection. A memory the user has since moved by other means is left
  alone, because `replaced` is terminal.

The explanation for *why* a pair was flagged lives on `memory_relation.reason`, the
owner-gated row it serves, and is erased with the pair. It is deliberately not in
the org-wide audit trail, which carries no content.

**Supersession from a contradiction verdict** applies only when the direction is
unambiguous: the model's winner must also be the temporally later memory, and
neither party may be `user_approved`. Any disagreement between model direction and
event order routes to a contradiction instead. Never silent supersession on doubt.

**Cross-owner contradictions are structurally impossible.** Reconciliation only ever
compares a fact with the same owner's, same-scope memories, so every relation is
intra-owner. A shared fact is read by peers but reconciled only within its owner's
memory.

## Dreaming: the nightly consolidation

Incremental by watermark, never a whole-store scan: from the last finished run's
window end to now, grouped per owner, each owner batch in its own transaction. A
crashed run leaves its window uncovered and it is re-covered next time, so the pass
is resumable by construction.

It does three things:

- Runs the reconciliation engine in batch over the window.
- **Staleness**: every `active` memory whose `valid_until` has passed transitions to
  `outdated`. Deterministic, model-free.
- **Dormancy**: an `active` commitment untouched for more than 14 days gets one open
  `dormant_flag` row. The memory's status is **not** touched. Flags clear when the
  memory stops being active.

The batch driver needs instance-wide scans no `Principal` can represent, so the
aggregate exposes four documented, worker-only system reads. Everything they feed
re-applies the per-owner gates before it can reach a user.

### The digest

`GET /api/dreaming/latest` returns at most six lines from the newest finished run,
scoped **by gate rather than by filter**: memory details resolve exclusively through
the caller's gated read, so another owner's actions produce no line at all. Silent
nights produce no card. Overflow beyond six folds into "and K more changes";
trimming priority is conflicts, merges, updates, quiet commitments, then the
staleness aggregate. Line ordering is load-bearing, because the attention feed's
dismissal keys index into it.

## Open loops

The founding question is *what did I decide, promise, and commit to, and what is
still open?* Cogeto answers it **without a task subsystem**: an open loop **is** a
memory whose `kind` is `commitment` or `open_loop` and whose status is `active`,
`user_approved`, or `uncertain`. Its due date is the memory's own `valid_until`;
"gone quiet" is the dormant flag.

`MemoryStore.openLoopsForPrincipal` is the single gated read;
`RetrievalService.openLoops` layers dormancy on top and is what **both** the chat
answer and the attention surface call, so there is one definition of "still open"
in the product rather than two that can drift.

### The first-person rule

An obligation is yours only when **you wrote the words it came from**. A loan
agreement says *"the Lender shall advance the principal sum"*. That is a true fact
about the document, it is extracted and stored and retrievable like any other, and
it is emphatically **not** something you promised. Presenting it as your open loop
would be the product lying about what it knows.

So authorship is recorded structurally at read time, never judged by a model:

| Source | Authorship |
| --- | --- |
| Note | the user's own |
| Captured chat | the user's own (only user messages are ever captured) |
| Uploaded document | not the user's |
| Fetched web page | not the user's |
| Email | resolved from whether the message came from the user's own address |

The open-loops read then admits first-person facts only. **Unknown authorship is
not the user's**: a fact the pipeline could not classify stays out, because a
wrongly surfaced obligation costs more than a missed one.

This rule lives on the read rather than on extraction, deliberately. Extraction
stays honest about what a document says; the surface stays honest about whose
obligation it is.

Statuses that no longer stand (`outdated`, `replaced`, `contradicted`) are excluded
structurally, so a settled obligation cannot reach the answer. `uncertain` stays in
and is framed softly: an unconfirmed promise is still a promise.

## Time travel

### One interval predicate, defined once

Intervals are **half-open**: `[valid_from, valid_until)`. A NULL `valid_from` means
"since ingestion", so `created_at` is the effective lower bound. A NULL
`valid_until` means "still holding".

> A fact **holds at t** iff
> `COALESCE(valid_from, created_at) <= t AND (valid_until IS NULL OR t < valid_until)`

A fact holds **at** its `valid_from` instant and does **not** hold at its
`valid_until` instant. Supersession sets the successor's `valid_from` to the
predecessor's `valid_until`, so at the boundary exactly one of the two holds: no
gap, no overlap.

This predicate exists **once**, in `memory/domain/interval.ts`, as a SQL fragment
and a pure TypeScript twin tested against each other on a truth table. No query,
view, or answer-side check may hand-roll it.

### Temporal mode is explicit, never inferred

Two deterministic guards, both required:

1. **Enable guard.** The rewriter is asked about temporal intent only when the raw
   question matches the temporal-hint lexicon (en + hr). No hint means the question
   can never classify as temporal, whatever the model says.
2. **Veto guard.** A model classification with no matching hint in the raw question
   is discarded, which guards against hallucinated intent.

Date resolution is deterministic: the rewriter returns the temporal kind plus the
raw expression verbatim, and code resolves it with the chrono resolver anchored to
now. Any resolution failure falls back to default mode, never an error. Default
retrieval is byte-for-byte unchanged.

### What the modes return

- **Point in time.** Memories whose interval covered `t` in **any** lifecycle status,
  `replaced` and `outdated` included, since they are the point of the query. Each
  carries its current status and `superseded_by`. Candidates are fetched temporally
  in SQL first and Qdrant only orders them, because the Qdrant payload cannot express
  the NULL-`valid_from` fallback or the NULL-`valid_until` arm, and an approximation
  would silently drop edge rows.
- **Previous.** The standard fused search with a temporal multiplier table replacing
  the defaults, so past facts rank nearly on par: `active`/`user_approved` ×1.0,
  `replaced` ×0.9, `outdated` ×0.9, `uncertain` ×0.6, `contradicted` ×0.4.
- **Changes since.** Three event kinds: `learned` (new rows), `status_changed`, and
  `superseded`. Deliberately excluded: sensitive toggles (metadata, not a fact
  change), relation bookkeeping (both parties' transitions already appear), edits
  (the supersession plus the successor's `learned` already tell the story), and
  deletions, whose ledger is Forgotten and which must never be reconstructed here.

**Temporal never weakens a hard gate.** Scope and sensitivity apply unchanged in
every mode; time travel does not cross owners.

### Past framing is a data contract, not a prompt hope

A fact is past belief iff its status is `replaced` or `outdated`, **or** its interval
is closed with `valid_until <= now`. The chat layer marks such facts in the DTO with
`pastBelief` and `supersededBy`; the answer prompt is required to present them as
past belief alongside what superseded them ("Until March you had X; since then Y"),
and the UI renders a muted "past" chip. The marker travels with the fact, so the
contract is testable without a model.
