# en-v007: RP2040 absolute maximum ratings and IO characteristics

**Source.** `rp2040-datasheet`, pages 615 and 616, sections 5.5.3.1 to 5.5.3.4.

**Why this case exists.** The conditional-qualification case. `VIH` is 2 V at
IOVDD=3.3 V, 1.7 V at 2.5 V and 0.65 times IOVDD at 1.8 V. Three values for one
symbol, differing only by a condition, in a table whose header appears once.
A system that drops the condition produces three facts that look like a
three-way conflict about the same slot, which is exactly the false finding a
findings report must not contain. The negative pair `en-vr06` scores it.

It is also the corpus's second table case, and the one where the page break
lands in the middle of the ESD table, so the maximum for fault-tolerant pins
sits on a different page from its header.

**Labels.** Eleven. `subject_entity` is declared on the IOVDD absolute maximum:
the same row exists in the RP2350 datasheet with a different value, and a
drifted subject would turn two correct facts into a false contradiction.

**Not labelled.** The pinout rows (pin numbers and power domains are a wiring
reference, not a fact a reader looks up), the running footer, and the two
further `VIH` and `VIL` rows at 1.8 V and 2.5 V.

AMBIGUOUS: dropping those two rows is the one place this case labels LESS than
the document states. They are genuine specifications, and a labeller could
include them. They are left out because including six near-identical
condition-varying rows would make recall on this case a measure of how many
table rows the extractor emits rather than whether it understood the table. The
two labelled rows carry the same test. Flagged so a future labeller who adds
them knows this was a decision, not an oversight, and knows to re-baseline the
gate when they do.

**Verification.** `supported`.
