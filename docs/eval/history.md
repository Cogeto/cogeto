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

## 2026-07-05 — extraction/v0002 + verification/v0002 (thresholds v1, 36 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 24 | 82.5% (33/40) | 91.2% (31/34) | 87.0% (20/23) |
| hr | 12 | 74.1% (20/27) | 95.0% (19/20) | 81.8% (9/11) |
| aggregate | 36 | 79.1% (53/67) | 92.6% (50/54) | 85.3% (29/34) |

## 2026-07-05 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-05 — extraction/v0002 + verification/v0003 (thresholds v1, 36 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 24 | 77.5% (31/40) | 85.3% (29/34) | 91.3% (21/23) |
| hr | 12 | 70.4% (19/27) | 90.0% (18/20) | 54.5% (6/11) |
| aggregate | 36 | 74.6% (50/67) | 87.0% (47/54) | 79.4% (27/34) |

## 2026-07-05 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-05 — extraction/v0002 + verification/v0003 (thresholds v1, 36 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 24 | 82.5% (33/40) | 94.1% (32/34) | 87.0% (20/23) |
| hr | 12 | 76.9% (20/26) | 95.0% (19/20) | 63.6% (7/11) |
| aggregate | 36 | 80.3% (53/66) | 94.4% (51/54) | 79.4% (27/34) |

## 2026-07-05 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-05 — extraction/v0002 + verification/v0004 (thresholds v1, 36 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 24 | 85.0% (34/40) | 94.1% (32/34) | 87.0% (20/23) |
| hr | 12 | 65.4% (17/26) | 80.0% (16/20) | 81.8% (9/11) |
| aggregate | 36 | 77.3% (51/66) | 88.9% (48/54) | 85.3% (29/34) |

## 2026-07-05 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

> Note: a degraded-prompt gate demonstration ran on 2026-07-05 (verification
> agreement 8.8%, build failed with exit 1, as designed). Its rows are
> deliberately not part of this history — the demo is documented in
> docs/sessions/F2-B.md ("Gate proof"). Honest numbers only means honest
> MEASUREMENTS; a sabotage drill is not a measurement.

## 2026-07-05 — extraction/v0002 + verification/v0004 (thresholds v1, 36 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 24 | 76.9% (30/39) | 85.3% (29/34) | 91.3% (21/23) |
| hr | 12 | 63.0% (17/27) | 80.0% (16/20) | 90.9% (10/11) |
| aggregate | 36 | 71.2% (47/66) | 83.3% (45/54) | 91.2% (31/34) |

## 2026-07-05 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 50.0% (2/4) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 66.7% (4/6) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-05 — extraction/v0002 + verification/v0004 (thresholds v1, 36 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 24 | 79.5% (31/39) | 88.2% (30/34) | 91.3% (21/23) |
| hr | 12 | 74.1% (20/27) | 95.0% (19/20) | 72.7% (8/11) |
| aggregate | 36 | 77.3% (51/66) | 90.7% (49/54) | 85.3% (29/34) |

## 2026-07-05 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-05 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0002 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | overall |
|---|---|---|---|---|---|---|---|
| atlas_scope | — | 83% | — | PASS | PASS | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | PASS |

## 2026-07-05 — extraction/v0002 + verification/v0004 (thresholds v1, 40 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 26 | 83.7% (36/43) | 92.1% (35/38) | 96.0% (24/25) |
| hr | 14 | 69.7% (23/33) | 91.7% (22/24) | 69.2% (9/13) |
| aggregate | 40 | 77.6% (59/76) | 91.9% (57/62) | 86.8% (33/38) |

## 2026-07-05 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-05 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0003 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | overall |
|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 50% | — | PASS | PASS | — | — | FAIL |
| changed_since | — | — | — | PASS | PASS | — | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | FAIL | FAIL |
| previously_decided | — | — | — | PASS | PASS | — | PASS | PASS |
| who_is_ana | PASS | 14% | PASS | PASS | PASS | — | — | FAIL |

## 2026-07-05 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0003 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | overall |
|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | PASS |

## 2026-07-05 — extraction/v0002 + verification/v0004 (thresholds v1, 40 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 26 | 83.3% (35/42) | 86.8% (33/38) | 96.0% (24/25) |
| hr | 14 | 64.7% (22/34) | 87.5% (21/24) | 84.6% (11/13) |
| aggregate | 40 | 75.0% (57/76) | 87.1% (54/62) | 92.1% (35/38) |

## 2026-07-05 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-05 — task_closure/v0001 + task_condition/v0001 (10 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 3 | 100.0% (5/5) | 2 | 100.0% (2/2) |
| hr | 3 | 100.0% (5/5) | 2 | 100.0% (2/2) |
| aggregate | 6 | 100.0% (10/10) | 4 | 100.0% (4/4) |

## 2026-07-05 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | overall |
|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | PASS |
| who_is_ana | PASS | 0% | PASS | PASS | PASS | — | — | FAIL |

## 2026-07-05 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | overall |
|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 83% | — | PASS | PASS | — | — | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | PASS |
| closure_flow | — | — | — | PASS | PASS | — | FAIL | FAIL |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | PASS |

## 2026-07-05 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | overall |
|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | PASS |
| who_is_ana | PASS | 0% | PASS | PASS | PASS | — | — | FAIL |

## 2026-07-05 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | overall |
|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 83% | — | PASS | PASS | — | — | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | PASS |
