# Document revisions: linking a corrected corpus to what it corrects

**V2.2 item 5.3, issue B. The decision record, frozen before the code. Owned
by `ingestion`; migration 0047 (`source_revision`).**

Re-importing a fixed document set is the moment revisions matter: without a
link, a corrected contract is just another document, and the findings story
cannot tell "resolved by correction" from "two more contradicting sources".

## The stance

**A wrong link corrupts the findings story; a missed link merely leaves two
independent sources, which is today's behaviour and therefore safe.** Every
rule below is conservative because of that asymmetry. When Cogeto is not
confident, it declines to link. There is no default arm that guesses.

## What makes B a revision of A

Candidates are generated ONLY from a structural event: a bulk import stages a
file whose **normalized filename** (case-folded, path stripped) matches an
existing file source of the same owner while its **content hash differs**.
A filename match alone is deliberately weak evidence, because folders
legitimately contain same-named files about different things; it nominates a
pair and decides nothing.

After the new file is ingested (so its anchoring context exists), the pair is
scored on corroborating signals:

| Signal | Meaning | Strength |
|---|---|---|
| S1: anchored revision | both sources carry an anchoring `revision`, both parse under one scheme (numeric-dotted like `2.1`/`v3`, or an ISO date), and the new one is later | strong |
| S2: same subject matter | anchored confident-subject overlap >= 0.5 (Jaccard, case-folded) AND the detected document class matches AND content shingle similarity >= 0.6 (Jaccard over 8-token shingles) | strong |

The decision:

- **S1 holds (and the document classes do not disagree): link automatically**,
  status `auto`, confidence `high`. The document itself states its succession;
  that is the one case worth acting on unasked, and it stays reversible.
- **S2 holds without S1: propose**, status `proposed`, confidence `medium`.
  The user confirms or rejects from Sources; nothing is linked until they do.
- **Neither holds: record nothing.** Not a low-confidence row, nothing. The
  two files remain independent sources, exactly as if the names had differed.

Thresholds (0.5 subject overlap, 0.6 shingle similarity) are constants beside
the scorer with their rationale, and moving them is a reviewed change, the
reconcile-config precedent.

## What is recorded

One `source_revision` row per decided pair, owned by `ingestion`:
successor and predecessor provenance refs, `status`
(`auto` | `proposed` | `confirmed` | `rejected` | `manual`), and a `basis`
JSON carrying every measured signal (normalized filename, both revision
fields, subject overlap, class match, shingle similarity, confidence) so the
decision is inspectable and reversible. Confirm, reject
and manual-link are owner-only endpoints, audited with structural detail. A
**rejected pair is remembered and never re-proposed**: the unique pair row
holds the rejection. Deleting either source removes the row through the
deletion cascade (a link naming an erased source is a dangling provenance
reference).

## What happens to the facts: nothing new

Fact-level behaviour is the EXISTING reconciliation machinery, deliberately.
The new revision's facts flow through stage 6 and the nightly pass exactly as
any ingestion does: `same_fact` merges, unambiguous supersession closes
intervals, conflicts become contradictions. The source-level link adds no
second supersession engine and triggers none; it is metadata about documents,
recorded precisely enough for what comes next.

## What 6.1 and 6.2 inherit (recorded here so they need not rediscover it)

When a revision's facts supersede facts that were sides of an open
contradiction, that contradiction becomes a candidate for **automatic
resolution with the causing revision as the recorded reason**: the state this
unit leaves behind is (a) the `source_revision` row naming successor and
predecessor, (b) the superseded facts' `superseded_by` pointers into the
revision's facts, and (c) the untouched `memory_relation` row, which 6.1's
findings lifecycle (open, resolved by revision, resolved by user, reopened)
will close from exactly that join. Delta reporting over imports and revisions
belongs to 6.2's report generator. This unit implements neither; it records
enough that both can be computed, never reconstructed.

## The surfaces

The links for a source render in the source drawer's inspection (the
[Sources surface](sources.md)): an `auto` link states its basis, a `proposed`
one carries confirm/reject, and "link an earlier version manually" covers the
case the conservative detector declined. Detection runs only in the bulk
import coordinator (candidates are a structural event of importing); the
read-and-decide endpoints are `GET/POST /api/source-revisions/*`.
