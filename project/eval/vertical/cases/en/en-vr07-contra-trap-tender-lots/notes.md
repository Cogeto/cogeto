# en-vr07: two lots of one tender rated differently

**Sides.** Both from `ted-178149-2026` page 3 (case `en-v009`).

**Expected.** `compatible`.

**Reasoning.** LABELLING.md rule 2, qualifier 2: same slot is a precondition,
and although both facts state an apparent power in MVA, they rate different
equipment in different lots of the same procurement.

What makes this harder than `en-vr03`: there the two facts came from two
documents captured a year apart, so recency at least distinguished them. Here
both come from the same document captured on the same day, so a reconciler that
falls back on "the newer one wins" has nothing to fall back on, and the only
thing separating the two facts is the lot each belongs to.

**Not ambiguous.**
