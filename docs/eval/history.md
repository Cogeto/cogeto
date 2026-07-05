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

## 2026-07-03 — extraction/v0001 + verification/v0001 (thresholds v1, 16 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 8 | 100.0% (12/12) | 100.0% (11/11) | 57.1% (4/7) |
| hr | 8 | 71.4% (10/14) | 81.8% (9/11) | 57.1% (4/7) |
| aggregate | 16 | 84.6% (22/26) | 90.9% (20/22) | 57.1% (8/14) |


## 2026-07-03 — extraction/v0001 + verification/v0001 (thresholds v1, 27 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 19 | 88.5% (23/26) | 91.3% (21/23) | 66.7% (12/18) |
| hr | 8 | 66.7% (10/15) | 81.8% (9/11) | 85.7% (6/7) |
| aggregate | 27 | 80.5% (33/41) | 88.2% (30/34) | 72.0% (18/25) |


## 2026-07-03 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0001 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | overall |
|---|---|---|---|---|---|---|---|
| atlas_scope | — | 67% | — | PASS | PASS | — | FAIL |
| nothing_on_record | — | — | — | — | — | PASS | PASS |
| who_is_ana | PASS | 13% | PASS | PASS | PASS | — | FAIL |

## 2026-07-03 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0002 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | overall |
|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | PASS |
| who_is_ana | PASS | 100% | PASS | PASS | PASS | — | PASS |

## 2026-07-03 — extraction/v0002 + verification/v0002 (thresholds v1, 27 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 19 | 92.3% (24/26) | 95.7% (22/23) | 94.4% (17/18) |
| hr | 8 | 73.3% (11/15) | 90.9% (10/11) | 57.1% (4/7) |
| aggregate | 27 | 85.4% (35/41) | 94.1% (32/34) | 84.0% (21/25) |

## 2026-07-03 — extraction/v0002 + verification/v0002 (thresholds v1, 27 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 19 | 88.5% (23/26) | 91.3% (21/23) | 88.9% (16/18) |
| hr | 8 | 66.7% (10/15) | 81.8% (9/11) | 57.1% (4/7) |
| aggregate | 27 | 80.5% (33/41) | 88.2% (30/34) | 80.0% (20/25) |

## 2026-07-05 — extraction/v0002 + verification/v0002 (thresholds v1, 27 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 19 | 91.7% (22/24) | 91.3% (21/23) | 100.0% (18/18) |
| hr | 8 | 68.8% (11/16) | 81.8% (9/11) | 100.0% (7/7) |
| aggregate | 27 | 82.5% (33/40) | 88.2% (30/34) | 100.0% (25/25) |

## 2026-07-05 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 14 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 4 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 3 | 75.0% (3/4) | 3 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 7 | 90.0% (9/10) | 7 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |
