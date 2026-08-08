# en-vr03: two parts, two crystal ranges, no conflict

**Sides.** `a` from `rp2350-datasheet` page 556 (case `en-v008`); `b` from
`rp2040-datasheet` page 217 (case `en-v006`).

**Expected.** `compatible`.

**Reasoning.** LABELLING.md rule 2, qualifier 1: same subject is a precondition
for a contradiction, and these two subjects are different microcontrollers. The
sentences around the numbers are word-for-word the same because Raspberry Pi
reused the paragraph, which is exactly what makes this hard: every similarity
signal the reconciler has says these are the same fact, and only the anchored
subject says they are not.

This is the pair the subject anchoring from V2.1 item 4.2 exists to win, and it
is why `en-v006` and `en-v008` declare `subject_entity` under the zero-tolerance
gate. If the subject drifts on either side, this pair becomes a false
contradiction and `en-vr09` becomes a false merge, from one root cause.

**Not ambiguous.** Nothing in either document suggests the two statements are
about one part.
