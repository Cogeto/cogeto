# hr-vr03: dvije grupe nabave, dvije vrijednosti

**Sides.** Both from `ted-hr-2133-2025` pages 2 and 3 (case `hr-v007`).

**Expected.** `compatible`.

**Reasoning.** LABELLING.md rule 2, qualifier 1: different subjects. FFP2 and
FFP3 are different protective classes and the notice procures them as separate
lots.

The Croatian counterpart of `en-vr07`, with one extra difficulty: the amounts
are written "2 992 000,00 EUR" with a space as the thousands separator and a
comma as the decimal mark. An English-convention parser reading that string can
produce 2, or 2992000, or 2.992, depending on where it stops, and two amounts
mis-parsed differently can turn a non-conflict into a conflict or the reverse.
The quantity parser's Croatian handling is what this pair puts under a gate.

**Not ambiguous.**
