# en-vr09: shared boilerplate must not merge two parts

**Sides.** `a` from `rp2350-datasheet` page 556; `b` from `rp2040-datasheet`
page 217.

**Expected.** `distinct`.

**Reasoning.** LABELLING.md section 3. This is the dedup half of the
same-boilerplate trap whose contradiction half is `en-vr03`. A false merge would
collapse two products into one memory and, worse, would leave whichever part
number survived attached to the other part's characteristics.

The corpus keeps both halves because they fail for opposite reasons and a system
can pass one while failing the other: merging everything passes `en-vr03` (no
contradiction is flagged) and fails this; treating every subject as distinct
passes this and fails `en-vr05`, where the same crystal in two documents must
merge.

**Not ambiguous.**
