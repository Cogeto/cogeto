# en-vr02: a withdrawn requirement supersedes the requirement

**Sides.** `a` from `nist-sp-800-171r3` page 47 (case `en-v005`); `b` from
`nist-sp-800-171r2` page 38 (case `en-v004`).

**Expected.** `supersedes_a_over_b`.

**Reasoning.** Every other supersession in this corpus turns on a value. This
one turns on a decision: the successor revision of the same publication
withdraws a control the predecessor required. LABELLING.md section 2 calls this
out explicitly, because a numeric reconciler that only compares quantities will
see nothing here at all, and the deterministic quantity arm from V2.3 item 6.1
cannot help.

The failure to watch for is not a wrong direction but silence: if the pair is
not even a candidate, an organisation keeps enforcing a control its standard
dropped, and Cogeto never mentions it. That outcome scores as a candidate miss
in the harness, which is why `candidate misses` is printed beside the rates.

**Not ambiguous.** The document states the withdrawal in its own words and gives
its reason. Nothing here needed a judgement call.
