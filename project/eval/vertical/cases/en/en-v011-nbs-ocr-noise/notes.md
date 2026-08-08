# en-v011: a scanned page that decoded to nothing

**Source.** `nbs-sp-250-3`, page 58. A 1987 typewritten publication digitised
with an OCR text layer; this page holds a rotated figure, and the text layer for
it is character debris.

**Why this case exists.** The reading ladder's whole point is that a page which
cannot be read says so instead of arriving as done-with-zero-facts. The
complementary requirement is on the extractor: given debris, it must produce
NOTHING. Extraction fabricates nothing (AGENTS.md); a parse or model failure
produces zero memories, never an invented one. The debris on this page contains
digit sequences (73, 00, 42) that a model under pressure to find a measurement
could read as values.

This is the corpus's trap case, and it is a real page from a real scan rather
than a constructed one.

**Labels.** None. `verification_expected` is `unsupported`, which is the trap
rule: the case agrees when no stray fact was admitted supported and unhedged.
Per `docs/eval-golden-set.md` section 5 a case with no expected memories may not
declare `supported` or `partial`, and this one declares the trap deliberately
rather than omitting the field, because "remembered nothing" is the behaviour
under test.

**Note on the ladder.** In the harness this page arrives as text, because the
golden-set harness scores extraction over the reader's output rather than
re-running the ladder. The ladder's own decision on this page (its text layer is
present but unusable, so a vision tier would be the next rung on an instance
that has one) is recorded in the diagnostic report, not gated here: gating it
would need a vision model in CI, which V2.1 item 4.1 deliberately did not add.
