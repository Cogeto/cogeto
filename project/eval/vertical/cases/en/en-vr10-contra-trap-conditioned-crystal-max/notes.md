# en-vr10: a condition on one side only

**Sides.** Both from `rp2350-datasheet`, `a` from section 8.2.2 on page 557 and
`b` from section 8.2.1 on page 556 (case `en-v008`).

**Expected.** `compatible`.

**Reasoning.** The unqualified statement says the part supports 1 to 50 MHz
crystals. The qualified one says the 50 MHz ceiling applies when
CTRL.FREQ_RANGE is set appropriately. They agree on the number and differ on
whether a condition is stated.

AMBIGUOUS, and this is the case LABELLING.md rule 0 was written for. A reader
could argue the unconditioned statement is incomplete and that flagging the
tension would be a service. The label is `compatible` because the conservative
choice is the one that penalises guessing: a findings report that raises a
conflict between two sentences of one section, two pages apart, which state the
same number, is noise, and noise is what destroys trust in a findings report.

The reasoning is recorded rather than the verdict alone, so a future labeller who
concludes that one-sided conditions deserve a flag can change this pair
deliberately and re-baseline the gate.
