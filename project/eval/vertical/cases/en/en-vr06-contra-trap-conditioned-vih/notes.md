# en-vr06: one part, one symbol, two conditions

**Sides.** Both from `rp2040-datasheet` page 616 (case `en-v007`), Table 625.

**Expected.** `compatible`.

**Reasoning.** LABELLING.md rule 2, qualifier 3. Unlike `en-vr03` and `en-vr04`,
the subject here is genuinely the same part and the slot is genuinely the same
symbol. Only the condition differs, and the condition is part of the fact. A
datasheet table states one symbol at several supply voltages as a matter of
course; a reconciler that drops the qualifier sees a two-way conflict inside a
single table on a single page.

This is the pair most likely to fail, because the condition lives in a column
header fragment (`@ IOVDD=3.3V`) that the PDF text layer separates from the
number by a line break and a symbol name. If the extractor does not carry the
condition onto the fact, nothing downstream can recover it.

**Not ambiguous:** the source states both conditions explicitly. The ambiguous
variant, where a condition appears on one side only, is `en-vr10`.
