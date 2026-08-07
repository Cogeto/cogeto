# reconcile_contradiction — changelog

- **v0002** (2026-08-07, V2.3 item 6.1 issue C): numeric and unit reasoning.
  Documents the machine-parsed `PARSED QUANTITIES` block (values converted to a
  common base unit; the judge is told to use those conversions instead of doing
  arithmetic), narrows the compatible-in-doubt rule with its one exception (two
  parsed values for the same slot differing beyond stated precision ARE a
  conflict; "close" is not a reconciling reading), and adds three contrast
  examples: same-slot different values → contradicts, same value in different
  units → compatible, changed value WITH update evidence → supersedes (the
  measured-value exception never overrides update evidence; the first
  measurement round showed the numeric emphasis tilting borderline supersedes
  pairs into contradicts, so the update-first ordering is stated explicitly).
  New judging rules cover ranges, tolerances, precision, one-sided conditions,
  additive same-person commitments, and check-supersedes-before-contradicts.
  Absent quantities the input is byte-identical to v0001's. Scored by the
  extended pair corpus in the same change.

- **v0001** (2026-07-05, F2-A): initial contradiction confirmation prompt (decision
  0010). Verdict contradicts | compatible | supersedes(direction) with a
  one-sentence reason. Explicit cost table: a wrong contradiction wastes the user's
  attention → hesitation between contradicts and compatible resolves to compatible;
  supersedes requires an explicit update relationship (newer value for the same
  slot), never mere difference, and loses every doubt (to contradicts against
  contradicts-doubt, to compatible against compatible-doubt). Three embedded
  contrast examples: same-slot conflict, same-topic/different-aspect compatible
  trap, and an explicit "moved to" supersession. Baseline scored by the
  reconciliation pair cases in the same session (docs/eval/history.md).
