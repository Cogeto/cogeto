# au-01: the amendment wins because it is the amendment

**PENDING. Not loaded by the harness.**

**Sources.** `mdr-amend-2023-607-en` page 4 and `mdr-2017-745-en` page 89.

**Signal under test.** Revision. The correct reason for `a` to win is that
2023/607 declares itself an amendment of 2017/745 and replaces the paragraph in
question. Recency is a proxy that happens to agree here.

**Why it is worth keeping despite that.** When authority ranking ships, this is
the regression case that proves the new reasoning did not break the old
behaviour. It should be moved into `../cases/en/` at that point.

**What would make it a real test.** A pair where the amendment is captured
BEFORE the act it amends, which happens routinely in a bulk import that walks a
folder alphabetically. That variant is not authored here because inventing a
capture order to defeat a mechanism that does not exist yet would be theatre;
it is a note for whoever ships the behaviour.
