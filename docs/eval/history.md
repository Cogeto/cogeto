# Eval history — golden-set results per run (§B.4)

Appended by `npm run eval`. These numbers become the published trust score once
the CI gates turn on (Session 4). Honest numbers only — a dip ships with an
explanation, never hidden (docs/eval-golden-set.md §7).

## 2026-07-03 — extraction/v0001 + verification/v0001 (thresholds v1, 16 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 8 | 92.9% (13/14) | 100.0% (11/11) | 57.1% (4/7) |
| hr | 8 | 71.4% (10/14) | 81.8% (9/11) | 71.4% (5/7) |
| aggregate | 16 | 82.1% (23/28) | 90.9% (20/22) | 64.3% (9/14) |

Notes on the first run: extraction recall misses are optional-adjacent facts in
hr-0004/hr-0006/hr-0007 (merged or threshold-missed claims); hr precision is
dragged by extra near-duplicate claims. The verification-agreement number
surfaces a real rubric tension, not random noise: when the extractor correctly
resolves a relative date ("next Friday" → 2026-07-10), the verifier — seeing
only "next Friday" in the passage — rules `partial` (en-0003, en-0004, en-0007,
hr-0003, hr-0004 all disagree this way). Fix belongs in verification/v0002
("a correctly resolved relative date is not an addition"), to be measured
against this baseline.
