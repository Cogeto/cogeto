# en-vr12: overlapping ranges on adjacent table rows

**Sides.** Both from `rp2350-datasheet` page 556, Table 597, adjacent rows.

**Expected.** `compatible`.

**Reasoning.** LABELLING.md rule 2, qualifier 2. The ranges -40 to +85 and -55
to +125 overlap, share a unit and a subject, and sit on consecutive lines of one
table, which is why a range comparator that reaches them without their row
labels will call them a conflict. The row label is the slot, and the slots are
different: one is what the crystal tolerates while running, the other what it
tolerates in a box.

The reason this is worth a pair rather than a unit test: the row label is the
only thing separating them, and in the PDF text layer it is the first two words
of a line whose numbers the extractor is reaching for. The information survives
or it does not, and that is a pipeline property rather than an arithmetic one.

**Not ambiguous.**
