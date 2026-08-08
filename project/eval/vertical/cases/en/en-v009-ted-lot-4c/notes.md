# en-v009: a public tender's technical requirements, two lots in one description

**Source.** `ted-178149-2026`, page 3. The lot description for the Reuter
Electrical Backbone transformer procurement.

**Why this case exists.** This is what a requirements specification looks like
when it arrives through a procurement portal: one unbroken paragraph carrying
two different lots, each with its own ratings, written in the shorthand an
engineer uses (`U = 400/110kV plus or minus 13 x 1,23%`, `S = 300MVA (360MVA)`,
`Uk = 16%`) with a comma decimal separator inside an otherwise English
document.

It is the corpus's strongest negative source. Lot 4c and Lot 4d are both
transformers, both measured in MVA, both in the same sentence block, and their
values differ. Pair `en-vr07` requires that difference NOT to be a
contradiction, which is the whole discipline a findings report depends on.

**Labels.** Ten, five per lot, with `subject_entity` declared on the lead fact
of each so a drifted subject fails the zero-tolerance gate rather than quietly
merging the two lots.

**Not labelled.** The page header, the internal LOT-0001 identifier, and the
orphaned exclusion-ground heading the page boundary left at the top.

AMBIGUOUS: the ratings are labelled as one fact per lot rather than one per
parameter. The source states them as a single unpunctuated run
(`S = 300MVA (360MVA) Uk =16% YNyn0`), and splitting them into five labels
would assert a structure the document does not have. Flagged because a labeller
who wanted per-parameter recall would split them, and that would change the
denominator.

**Verification.** `supported`.

## The subject declarations were REMOVED, and why

Both lot lead facts originally declared `subject_entity`, which puts them under
the zero-tolerance `subject_mismatches` gate. They held on two live runs and
failed on a third:

```
en-v009: SUBJECT MISMATCH, expected "Lot 4c",
 got "Projekt Reuter Electrical Backbone"
```

That is finding 3 of the diagnostic report exactly: the anchored **document**
subject outranking the **section** subject. The anchor identified Lot 4c and Lot
4d as distinct confident subjects; the extractor stamped the project name on the
facts anyway.

Removed for the reason the Croatian declarations were removed, and it matters
more here because these two held twice before failing: a gate that passes twice
and fails on the third identical run is a coin flip, and the governing rule
inherited from V2.0 item 3.4 says a gate inside a metric's run-to-run band is
worse than no gate, because it teaches people to bypass it.

**What still protects this case.** The negative pairs `en-vr07` and `en-vr11`
require Lot 4c and Lot 4d to stay apart, and they are scored inside the
reconciliation rates. The five `subject_entity` declarations that remain in the
corpus are all on the two datasheets (`en-v006`, `en-v007`, `en-v008`), which
held on all three runs, and those are the ones the same-boilerplate traps depend
on.
