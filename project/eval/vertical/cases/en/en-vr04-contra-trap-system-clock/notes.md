# en-vr04: two parts, two maximum system clocks, no conflict

**Sides.** `a` from `rp2350-datasheet` page 556; `b` from `rp2040-datasheet`
page 217.

**Expected.** `compatible`.

**Reasoning.** Identical to `en-vr03` and kept as a separate pair because a
single negative proves nothing about a rule. Here the two sentences differ by
the number and by whether there is a space before MHz ("150 MHz" against
"133MHz"), and nothing else. The vendor's own formatting is inconsistent between
its two datasheets, which is a detail no synthetic corpus would think to
include and which a normaliser must handle before the numbers can even be
compared.

**Not ambiguous.**
