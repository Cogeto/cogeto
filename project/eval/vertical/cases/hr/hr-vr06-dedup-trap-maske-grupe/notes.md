# hr-vr06: dvije grupe s istim predloškom ne smiju se spojiti

**Sides.** Both from `ted-hr-2133-2025` pages 2 and 3 (case `hr-v007`).

**Expected.** `distinct`.

**Reasoning.** The Croatian counterpart of `en-vr11`. What makes it a slightly
different test is that the two lots share their CPV classification code
(33140000, medical consumables) and their contract duration, so the only
distinguishing content is the product class in the title, and that class is an
alphanumeric token (FFP2, FFP3) rather than a word. Embedding similarity is
close to blind between "FFP2" and "FFP3".

A false merge here would tell a buyer that one lot covers both mask classes,
which is a procurement error, and dedup traps count double for that reason.

**Not ambiguous.**
