# Authority-ranking cases: authored, PENDING, not gated

*V2.3 item 6.4, issue C, point 3. These cases are written and they do NOT run.*

## Why they are here and not in `../cases/`

The plan asks for authority-ranking cases "if that behaviour has shipped or is
imminent", and says to author them and mark them pending otherwise. **It has not
shipped.** Nothing in Cogeto today decides which of two disagreeing sources
wins by document class, by revision, or by recency of publication:

- `reconcile.stage` decides supersession from **fact recency and validity
  intervals**, not from what kind of document a fact came from;
- the anchoring context (V2.1 item 4.2) records a `document_class` and a
  `revision` on `source_context`, and **nothing downstream reads either when
  reconciling**;
- V2.3 item 6.1's finding lifecycle can resolve a finding **by revision**, but
  the revision link comes from `source_revision` (V2.2 item 5.3), which pairs
  documents by subject, class and content similarity. It does not rank two
  documents by authority; it says they are versions of one document.

Gating cases against behaviour that does not exist would put a permanently red
check on `main`, which the governing rule from V2.0 item 3.4 forbids in the
plainest terms: never set a gate the project is currently failing, because a
permanently red gate is not a gate, it teaches people to bypass it.

So these cases live outside `../cases/`, which is the directory the harness
loads. **The harness cannot see them.** Moving a case into `../cases/` is the
one action needed to gate it, and it should happen in the pull request that
ships the behaviour, together with a floor measured the same way every other
floor here was.

## What each case asserts

Every file is a `pair.json` in exactly the format the reconciliation harness
reads, so no rewriting is needed when they move. Each has a `notes.md` giving
the source, the expected verdict, and which of the three authority signals it
depends on.

| Case | Signal | The question it asks |
|---|---|---|
| `au-01-revision-wins` | revision | A regulation and its amending act disagree about a date. The amendment wins because it names the act it amends, not because it is newer. |
| `au-02-class-wins` | document class | A binding regulation and a tender notice disagree about a retention period. The regulation wins because of what it is. |
| `au-03-recency-loses-to-class` | class over recency | The tender notice is the more recent document AND the less authoritative one. Recency must not decide. |
| `au-04-change-notice-invalidates` | revision, indirect | A change notice says the technical specifications changed, without restating them. Every fact extracted from the superseded specification is now stale, and nothing today notices. |

`au-04` is the one worth reading first. It is drawn from
`ted-hr-2133-2025`, whose change block says that the technical specifications,
bills of quantities, draft contracts and the submission deadline have all
changed, and does not say what they changed to. That is a document telling you
your memory is stale in a way no pair comparison can detect, because the new
values are in an attachment nobody has ingested. It is recorded here as the
shape of the problem rather than as a case anyone can pass today.

## The honest statement for the trust page

Cogeto publishes no authority-ranking claim. When two sources disagree it raises
a finding for a person to resolve, and the only automatic resolution it performs
is supersession by recency and validity interval within a subject. Anyone
reading "verified institutional memory" should know that the verification is of
facts against their own source sentence, and that ranking sources against each
other is a later version's work.
