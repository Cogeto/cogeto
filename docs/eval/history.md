# Eval history — golden-set results per run (spec §14)

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
> deliberately not part of this history. Honest numbers only means honest
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

## 2026-07-09 — extraction/v0002 + verification/v0004 (thresholds v1, 46 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 29 | 85.7% (42/49) | 97.6% (40/41) | 85.7% (24/28) |
| hr | 17 | 76.5% (26/34) | 88.9% (24/27) | 87.5% (14/16) |
| aggregate | 46 | 81.9% (68/83) | 94.1% (64/68) | 86.4% (38/44) |

## 2026-07-09 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-09 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 83.3% (5/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 91.7% (11/12) | 4 | 100.0% (4/4) |

## 2026-07-09 — extraction/v0002 + verification/v0004 (thresholds v1, 46 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 29 | 91.5% (43/47) | 97.6% (40/41) | 89.3% (25/28) |
| hr | 17 | 68.6% (24/35) | 81.5% (22/27) | 87.5% (14/16) |
| aggregate | 46 | 81.7% (67/82) | 91.2% (62/68) | 88.6% (39/44) |

## 2026-07-09 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-09 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-10 — redaction mode (O3-B): eval delta OFF vs ON — PENDING owner run

Redaction mode (Addendum B.8, decision 0023) pseudonymizes every outbound model
call, embeddings included. The delta is measured by running the golden set both
ways (needs the sidecar up + a Mistral key):

```bash
npm run eval                                                          # OFF (baseline)
REDACTION_ENABLED=1 REDACTION_URL=http://localhost:8080 npm run eval  # ON
```

**Not measured in-session** — the O3-B session could not run it in-band (it needs
the built Presidio image + a live Mistral budget; the same honesty applied to the
O3-A live compose). Record both rows here after the owner run. Expected shape
(decision 0023): extraction precision/recall and verification agreement move
little (the model sees consistent pseudonyms within a call and the gateway
re-identifies the structured result); the embedding-dependent surfaces — dedup
similarity and `eval:chat` retrieval coverage — take the largest hit, because
per-call pseudonym numbering is not consistent across documents. If the measured
drop is material, that is the argument to pull local embeddings forward from
v1.x. Postgres FTS + entity-array retrieval run on the real (un-redacted, in-box)
text, which softens the embedding cost.

| set | run | extraction precision | extraction recall | verification agreement | dedup accuracy |
|---|---|---|---|---|---|
| aggregate | OFF (baseline) | _fill in_ | _fill in_ | _fill in_ | _fill in_ |
| aggregate | ON (redaction) | _fill in_ | _fill in_ | _fill in_ | _fill in_ |

## 2026-07-10 — extraction/v0002 + verification/v0004 (thresholds v1, 46 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 29 | 87.5% (42/48) | 97.6% (40/41) | 82.1% (23/28) |
| hr | 17 | 75.8% (25/33) | 88.9% (24/27) | 81.3% (13/16) |
| aggregate | 46 | 82.7% (67/81) | 94.1% (64/68) | 81.8% (36/44) |

## 2026-07-10 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-10 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-10 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

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

## 2026-07-13 — extraction/v0002 + verification/v0004 (thresholds v1, 46 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 29 | 85.1% (40/47) | 95.1% (39/41) | 96.4% (27/28) |
| hr | 17 | 67.6% (23/34) | 81.5% (22/27) | 93.8% (15/16) |
| aggregate | 46 | 77.8% (63/81) | 89.7% (61/68) | 95.5% (42/44) |

## 2026-07-13 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 18 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 5 | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 4 | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 9 | 80.0% (4/5) | 100.0% (4/4) | 0/1 | 0 |

## 2026-07-13 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-16 — extraction/v0002 + verification/v0004 (thresholds v1, 52 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 32 | 83.3% (40/48) | 88.6% (39/44) | 87.1% (27/31) |
| hr | 20 | 75.7% (28/37) | 90.0% (27/30) | 89.5% (17/19) |
| aggregate | 52 | 80.0% (68/85) | 89.2% (66/74) | 88.0% (44/50) |

## 2026-07-16 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-16 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-16 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | overall |
|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 67% | — | PASS | PASS | — | — | FAIL |
| changed_since | — | — | — | PASS | PASS | — | PASS | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | PASS |
| who_is_ana | PASS | 100% | PASS | PASS | PASS | — | — | PASS |

## 2026-07-19 — extraction/v0002 + verification/v0004 (thresholds v1, 68 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 33 | 90.0% (45/50) | 95.6% (43/45) | 96.9% (31/32) |
| hr | 35 | 78.0% (39/50) | 84.4% (38/45) | 88.2% (30/34) |
| aggregate | 68 | 84.0% (84/100) | 90.0% (81/90) | 92.4% (61/66) |

## 2026-07-19 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-19 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-19 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | overall |
|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 33% | — | PASS | PASS | — | — | FAIL |
| changed_since | — | — | — | PASS | PASS | — | PASS | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | PASS |
| who_is_ana | PASS | 14% | PASS | PASS | PASS | — | — | FAIL |

## 2026-07-21 — extraction/v0002 + verification/v0004 (thresholds v1, 68 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 33 | 90.0% (45/50) | 97.8% (44/45) | 93.8% (30/32) |
| hr | 35 | 81.6% (40/49) | 86.7% (39/45) | 88.2% (30/34) |
| aggregate | 68 | 85.9% (85/99) | 92.2% (83/90) | 90.9% (60/66) |

## 2026-07-21 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-21 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-21 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

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
| reply_hr_zadnja | — | — | — | — | — | — | PASS | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | PASS |

## 2026-07-21 — extraction/v0002 + verification/v0004 (thresholds v1, 68 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 33 | 86.3% (44/51) | 95.6% (43/45) | 87.5% (28/32) |
| hr | 35 | 75.5% (40/53) | 84.4% (38/45) | 88.2% (30/34) |
| aggregate | 68 | 80.8% (84/104) | 90.0% (81/90) | 87.9% (58/66) |

## 2026-07-21 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-21 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-21 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | overall |
|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 50% | — | PASS | PASS | — | — | — | FAIL |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | FAIL | FAIL |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | — | PASS |

## 2026-07-21 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | overall |
|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 50% | — | PASS | PASS | — | — | — | FAIL |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | PASS |
| who_is_ana | PASS | 0% | PASS | PASS | PASS | — | — | — | FAIL |

## 2026-07-21 — chat eval (pipeline=mistral-small-latest · answer=mistral-medium-latest · answer-prompt=answer/v0004 · grader=eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | overall |
|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 50% | — | PASS | PASS | — | — | — | FAIL |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | — | PASS |

## 2026-07-21 — extraction/v0002 + verification/v0004 (thresholds v1, 68 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 33 | 84.8% (39/46) | 84.4% (38/45) | 93.3% (28/30) |
| hr | 35 | 78.2% (43/55) | 93.3% (42/45) | 85.3% (29/34) |
| aggregate | 68 | 81.2% (82/101) | 88.9% (80/90) | 89.1% (57/64) |

## 2026-07-21 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-21 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-21 — extraction/v0002 + verification/v0004 (thresholds v1, 68 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 33 | 86.3% (44/51) | 93.3% (42/45) | 93.8% (30/32) |
| hr | 35 | 76.4% (42/55) | 91.1% (41/45) | 85.3% (29/34) |
| aggregate | 68 | 81.1% (86/106) | 92.2% (83/90) | 89.4% (59/66) |

## 2026-07-21 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-21 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-21 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0004 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | overall |
|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 83% | — | PASS | PASS | — | — | — | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | PASS |
| who_is_ana | PASS | 14% | PASS | PASS | PASS | — | — | — | FAIL |

## 2026-07-22 — extraction/v0002 + verification/v0004 (thresholds v1, 68 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 33 | 89.8% (44/49) | 91.1% (41/45) | 90.6% (29/32) |
| hr | 35 | 76.9% (40/52) | 86.7% (39/45) | 82.4% (28/34) |
| aggregate | 68 | 83.2% (84/101) | 88.9% (80/90) | 86.4% (57/66) |

## 2026-07-22 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-22 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-22 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0004 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | overall |
|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | — | PASS |

## 2026-07-22 — extraction/v0002 + verification/v0004 (thresholds v1, 68 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 33 | 90.2% (46/51) | 95.6% (43/45) | 93.8% (30/32) |
| hr | 35 | 76.4% (42/55) | 88.9% (40/45) | 79.4% (27/34) |
| aggregate | 68 | 83.0% (88/106) | 92.2% (83/90) | 86.4% (57/66) |

## 2026-07-22 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-22 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-22 — chat eval (configuration=pipe-mistral-mistral-small-latest--ans-mistral-mistral-medium-latest--emb-ollama-bge-m3 · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0004 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | overall |
|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | — | PASS |

## 2026-07-22 — extraction/v0002 + verification/v0004 (thresholds v1, 68 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 33 | 80.4% (41/51) | 91.1% (41/45) | 93.8% (30/32) |
| hr | 35 | 69.4% (34/49) | 75.6% (34/45) | 88.2% (30/34) |
| aggregate | 68 | 75.0% (75/100) | 83.3% (75/90) | 90.9% (60/66) |

## 2026-07-22 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 66.7% (2/3) | 66.7% (2/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (2/2) | 66.7% (2/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 80.0% (4/5) | 66.7% (4/6) | 0/1 | 0 |

## 2026-07-22 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-22 — chat eval (configuration=ollama-local · pipeline=ollama/gemma3:12b · answer=ollama/gemma3:12b · answer-prompt=answer/v0004 · grader=ollama/gemma3:12b eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | overall |
|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | FAIL | FAIL |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | PASS |
| who_is_ana | PASS | 71% | PASS | PASS | PASS | — | — | — | FAIL |

## 2026-07-23 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0005 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | — | — | PASS |
| blended_origins_en | PASS | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | FAIL | — | FAIL |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | FAIL | — | — | — | FAIL |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | FAIL | — | FAIL |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | — | — | — | PASS |

## 2026-07-23 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0005 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | — | — | PASS |
| blended_origins_en | PASS | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | PASS | — | PASS |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| previously_decided | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | — | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| who_is_ana | PASS | 14% | PASS | PASS | PASS | — | — | — | — | — | FAIL |

## 2026-07-23 — extraction/v0002 + verification/v0004 (thresholds v1, 70 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 34 | 82.1% (46/56) | 91.5% (43/47) | 90.9% (30/33) |
| hr | 36 | 78.9% (45/57) | 91.5% (43/47) | 80.0% (28/35) |
| aggregate | 70 | 80.5% (91/113) | 91.5% (86/94) | 85.3% (58/68) |

## 2026-07-23 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-23 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-23 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0005 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 50% | — | PASS | PASS | — | — | — | — | — | FAIL |
| blended_origins_en | PASS | 100% | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | PASS | — | PASS |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| previously_decided | — | 100% | — | PASS | PASS | — | PASS | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | — | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | FAIL | — | FAIL |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| who_is_ana | PASS | 14% | PASS | PASS | PASS | — | — | — | — | — | FAIL |

## 2026-07-23 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0005 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | — | — | PASS |
| blended_origins_en | PASS | 100% | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | PASS | — | PASS |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| previously_decided | — | 100% | — | PASS | PASS | — | PASS | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | — | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | — | — | — | PASS |

### Priority 6 note — the four 2026-07-23 chat runs above, honestly

The four chat tables above are the natural-conversation (decision 0046)
development runs, in order; the golden-set/reconcile/task tables between them
are the same day's full golden run (all gates PASS).

1. **Run 1** (23 cases, first with `answer/v0005` + `query_rewrite/v0004`):
   20/23. It exposed a real routing regression — the reply-target entities
   fallback manufactured a phantom sender on `reply_hr_zadnja` (fixed in
   `detectEmailReplyIntent`: entities now fill in only for a resolved
   pronoun) — plus a thin `followup_cross_capability` fixture and a live
   keep-subject miss on `research_keeps_subject_hr` (minimisation dropped the
   subject; hardened in `research_query_minimise/v0002`).
2. **Run 2**: all three fixes verified green; `who_is_ana` drew 14% coverage
   (the recurring she→Marta rewriter flake decision 0036 documents).
3. **Run 3** (first gated run): `who_is_ana` drew 14% again, and the
   synthesiser declined on `research_keeps_subject_hr` by reading the hr
   occasion phrase ("prije sastanka u četvrtak") as an information constraint
   (hardened in `research_answer/v0002`). Coverage grading was widened from 2
   to 4 cases here (`previously_decided`, `blended_origins_en` — both already
   deterministically checked on the same content) so one noisy judgment
   cannot swing the mean gate, which is 0036's stated intent.
4. **Run 4** (gated, final — the Priority 6 baseline): **23/23 PASS, rule
   checks all PASS, mean coverage 96.4% over 4 graded cases (gate ≥ 65%)**,
   with `query_rewrite/v0004` gaining the deterministic `USER-NAMED ENTITIES`
   assist that resolved the she→Marta drift in this run.

## 2026-07-23 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0005 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | — | — | PASS |
| blended_origins_en | PASS | 100% | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | PASS | — | PASS |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| previously_decided | — | 100% | — | PASS | PASS | — | PASS | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | — | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | — | — | — | PASS |

### Research-in-chat note — the chat table above (2026-07-23, decision 0047)

Gated re-run on the research-in-chat branch (inline gate + progress feed + the
concluding grounded turn; no prompt changes): **23/23 PASS, rule checks all
PASS, mean coverage 96.4%** — the gate's server semantics are byte-identical,
so the research cases pass unchanged.

## 2026-07-24 — extraction/v0002 + verification/v0004 (thresholds v1, 70 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 34 | 85.2% (46/54) | 89.4% (42/47) | 90.9% (30/33) |
| hr | 36 | 75.0% (45/60) | 93.6% (44/47) | 85.7% (30/35) |
| aggregate | 70 | 79.8% (91/114) | 91.5% (86/94) | 88.2% (60/68) |

## 2026-07-24 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-24 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-24 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0006 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 67% | — | PASS | PASS | — | — | — | — | — | FAIL |
| blended_origins_en | PASS | 100% | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| digest_hr_preferred | — | — | — | — | — | — | — | — | — | PASS | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | PASS | — | PASS |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| previously_decided | — | 100% | — | PASS | PASS | — | PASS | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | — | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| strict_mode_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| who_is_ana | PASS | 14% | PASS | PASS | PASS | — | — | — | — | — | FAIL |

## 2026-07-24 — extraction/v0002 + verification/v0004 (thresholds v1, 76 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 37 | 81.0% (51/63) | 90.4% (47/52) | 91.7% (33/36) |
| hr | 39 | 84.4% (54/64) | 96.2% (50/52) | 78.9% (30/38) |
| aggregate | 76 | 82.7% (105/127) | 93.3% (97/104) | 85.1% (63/74) |

## 2026-07-24 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-24 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-24 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0006 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | — | — | PASS |
| blended_origins_en | PASS | 100% | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| digest_hr_preferred | — | — | — | — | — | — | — | — | — | PASS | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | PASS | — | PASS |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| previously_decided | — | 100% | — | PASS | PASS | — | PASS | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | — | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| strict_mode_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| who_is_ana | PASS | 14% | PASS | PASS | PASS | — | — | — | — | — | FAIL |

## 2026-07-24 — extraction/v0002 + verification/v0004 (thresholds v1, 76 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 37 | 84.4% (54/64) | 94.2% (49/52) | 88.9% (32/36) |
| hr | 39 | 72.5% (50/69) | 90.4% (47/52) | 86.8% (33/38) |
| aggregate | 76 | 78.2% (104/133) | 92.3% (96/104) | 87.8% (65/74) |

## 2026-07-24 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-24 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-24 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0006 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | — | — | PASS |
| blended_origins_en | PASS | 100% | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| digest_hr_preferred | — | — | — | — | — | — | — | — | — | PASS | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | PASS | — | PASS |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| previously_decided | — | 100% | — | PASS | PASS | — | PASS | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | — | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| strict_mode_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| who_is_ana | PASS | 14% | PASS | PASS | PASS | — | — | — | — | — | FAIL |

## 2026-07-25 — extraction/v0002 + verification/v0004 (thresholds v1, 76 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 37 | 80.6% (54/67) | 92.3% (48/52) | 86.1% (31/36) |
| hr | 39 | 77.3% (51/66) | 90.4% (47/52) | 84.2% (32/38) |
| aggregate | 76 | 78.9% (105/133) | 91.3% (95/104) | 85.1% (63/74) |

## 2026-07-25 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (2/2) | 66.7% (2/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 83.3% (5/6) | 83.3% (5/6) | 0/1 | 0 |

## 2026-07-25 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-25 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0006 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | — | — | PASS |
| blended_origins_en | PASS | 100% | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | — | — | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| digest_hr_preferred | — | — | — | — | — | — | — | — | — | PASS | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | PASS | — | PASS |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| previously_decided | — | 100% | — | PASS | PASS | — | PASS | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | — | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | PASS | PASS |
| strict_mode_hr | — | — | — | PASS | PASS | — | PASS | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS | — | — | — | — | — | PASS |

## 2026-07-25 — chat eval (configuration=ollama-local · pipeline=ollama/gemma3:12b · answer=ollama/gemma3:12b · answer-prompt=answer/v0006 · grader=ollama/gemma3:12b eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 100% | — | PASS | PASS | — | — | — | — | — | — | PASS |
| blended_origins_en | PASS | 100% | — | PASS | PASS | — | PASS | — | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | FAIL | — | — | — | FAIL |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| digest_hr_preferred | — | — | — | — | — | — | — | — | — | — | PASS | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | FAIL | — | — | FAIL |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | FAIL | — | — | — | — | — | FAIL |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| previously_decided | — | 100% | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | — | — | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | PASS | — | — | PASS |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | — | PASS |
| skill_brief_en | — | — | — | PASS | — | — | PASS | — | — | PASS | — | PASS |
| skill_brief_hr | — | — | — | PASS | — | — | PASS | — | — | PASS | PASS | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | — | PASS | PASS |
| strict_mode_hr | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| who_is_ana | FAIL | 14% | PASS | PASS | PASS | — | — | — | — | — | — | FAIL |

## 2026-07-25 — extraction/v0002 + verification/v0004 (thresholds v1, 76 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 37 | 84.4% (54/64) | 96.2% (50/52) | 91.7% (33/36) |
| hr | 39 | 73.1% (49/67) | 86.5% (45/52) | 89.5% (34/38) |
| aggregate | 76 | 78.6% (103/131) | 91.3% (95/104) | 90.5% (67/74) |

## 2026-07-25 — reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) | — | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-25 — task_closure/v0001 + task_condition/v0001 (12 pairs)

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| hr | 4 | 100.0% (6/6) | 2 | 100.0% (2/2) |
| aggregate | 8 | 100.0% (12/12) | 4 | 100.0% (4/4) |

## 2026-07-25 — chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0006 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope | — | 50% | — | PASS | PASS | — | — | — | — | — | — | FAIL |
| blended_origins_en | PASS | 100% | — | PASS | PASS | — | PASS | — | — | — | PASS | PASS |
| changed_since | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| closure_flow | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| create_task_en_conditioned | — | — | — | — | — | — | PASS | PASS | — | — | — | PASS |
| create_task_hr_uvjet | — | — | — | — | — | — | PASS | PASS | — | — | — | PASS |
| default_no_time_travel | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| digest_hr_preferred | — | — | — | — | — | — | — | — | — | — | PASS | PASS |
| followup_cross_capability | — | — | — | PASS | PASS | — | PASS | — | PASS | — | — | PASS |
| knowledge_offer_en | — | — | — | PASS | PASS | — | — | — | — | — | PASS | PASS |
| knowledge_offer_hr | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS | PASS |
| memory_beats_model | PASS | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| nothing_on_record | — | — | — | — | — | PASS | — | — | — | — | — | PASS |
| open_with_entity | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| point_in_time_march | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| previously_decided | — | 100% | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| reply_hr_zadnja | — | — | — | — | — | — | PASS | — | — | — | — | PASS |
| reply_to_ana | — | — | — | — | — | — | PASS | — | — | — | — | PASS |
| research_keeps_subject_hr | — | — | — | PASS | — | — | PASS | — | PASS | — | — | PASS |
| research_minimise_drop | — | — | — | PASS | — | — | PASS | — | PASS | — | — | PASS |
| skill_brief_en | — | — | — | PASS | — | — | PASS | — | — | PASS | — | PASS |
| skill_brief_hr | — | — | — | PASS | — | — | PASS | — | — | PASS | PASS | PASS |
| smalltalk_hvala_hr | — | — | — | PASS | PASS | — | — | — | — | — | PASS | PASS |
| smalltalk_thanks | — | — | — | PASS | PASS | — | — | — | — | — | PASS | PASS |
| strict_mode_hr | — | — | — | PASS | PASS | — | PASS | — | — | — | PASS | PASS |
| whats_still_open | — | — | — | PASS | PASS | — | PASS | — | — | — | — | PASS |
| who_is_ana | PASS | 14% | PASS | PASS | PASS | — | — | — | — | — | — | FAIL |

## 2026-07-29, extraction/v0002 + verification/v0004 (thresholds v1, 76 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 37 | 81.3% (52/64) | 90.4% (47/52) | 97.2% (35/36) |
| hr | 39 | 71.0% (49/69) | 88.5% (46/52) | 84.2% (32/38) |
| aggregate | 76 | 75.9% (101/133) | 89.4% (93/104) | 90.5% (67/74) |

## 2026-07-29, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) |  | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-29, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 33% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-29, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 100% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-29, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 100% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-29, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 50% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-29, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 100% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-30, extraction/v0003 + verification/v0006 (thresholds v1, 82 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 40 | 78.9% (56/71) | 92.6% (50/54) | 97.4% (38/39) |
| hr | 42 | 76.1% (54/71) | 90.7% (49/54) | 82.9% (34/41) |
| aggregate | 82 | 77.5% (110/142) | 91.7% (99/108) | 90.0% (72/80) |

## 2026-07-30, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) |  | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-30, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-30, extraction/v0004 + verification/v0006 (thresholds v1, 86 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 42 | 82.4% (61/74) | 94.6% (53/56) | 95.1% (39/41) |
| hr | 44 | 76.7% (56/73) | 92.9% (52/56) | 86.0% (37/43) |
| aggregate | 86 | 79.6% (117/147) | 93.8% (105/112) | 90.5% (76/84) |

## 2026-07-30, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) |  | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-30, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-30, extraction/v0004 + verification/v0006 (thresholds v1, 86 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 42 | 82.9% (58/70) | 92.9% (52/56) | 97.6% (40/41) |
| hr | 44 | 77.1% (54/70) | 89.3% (50/56) | 90.7% (39/43) |
| aggregate | 86 | 80.0% (112/140) | 91.1% (102/112) | 94.0% (79/84) |

## 2026-07-30, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) |  | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-30, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 100% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | FAIL | PASS | FAIL |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-30, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 50% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-31, extraction/v0004 + verification/v0006 (thresholds v1, 86 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 42 | 82.2% (60/73) | 94.6% (53/56) | 92.7% (38/41) |
| hr | 44 | 75.4% (52/69) | 87.5% (49/56) | 86.0% (37/43) |
| aggregate | 86 | 78.9% (112/142) | 91.1% (102/112) | 89.3% (75/84) |

## 2026-07-31, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 20 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 6 | 75.0% (3/4) | 100.0% (3/3) | 0/1 | 0 |
| hr | 4 | 83.3% (5/6) | 5 | 100.0% (3/3) | 100.0% (3/3) |  | 0 |
| aggregate | 9 | 92.9% (13/14) | 11 | 85.7% (6/7) | 100.0% (6/6) | 0/1 | 0 |

## 2026-07-31, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 33% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 29% | PASS | PASS | PASS |  |  |  |  |  | FAIL |

## 2026-07-31, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 100% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-31, extraction/v0004 + verification/v0006 (thresholds v1, 86 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 42 | 81.9% (59/72) | 94.6% (53/56) | 92.7% (38/41) |
| hr | 44 | 76.4% (55/72) | 92.9% (52/56) | 83.7% (36/43) |
| aggregate | 86 | 79.2% (114/144) | 93.8% (105/112) | 88.1% (74/84) |

## 2026-07-31, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 29 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 10 | 75.0% (3/4) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| hr | 4 | 83.3% (5/6) | 10 | 60.0% (3/5) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| aggregate | 9 | 92.9% (13/14) | 20 | 66.7% (6/9) | 100.0% (6/6) | 75.0% (6/8) | 0 |

## 2026-07-31, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-07-31, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-31, extraction/v0004 + verification/v0006 (thresholds v1, 86 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 42 | 82.2% (60/73) | 94.6% (53/56) | 95.1% (39/41) |
| hr | 44 | 79.2% (57/72) | 92.9% (52/56) | 90.7% (39/43) |
| aggregate | 86 | 80.7% (117/145) | 93.8% (105/112) | 92.9% (78/84) |

## 2026-07-31, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 29 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 10 | 75.0% (3/4) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| hr | 4 | 83.3% (5/6) | 10 | 60.0% (3/5) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| aggregate | 9 | 92.9% (13/14) | 20 | 66.7% (6/9) | 100.0% (6/6) | 75.0% (6/8) | 0 |

## 2026-07-31, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-07-31, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 33% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-31, extraction/v0004 + verification/v0006 (thresholds v1, 86 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 42 | 80.3% (57/71) | 92.9% (52/56) | 95.1% (39/41) |
| hr | 44 | 74.0% (54/73) | 89.3% (50/56) | 81.4% (35/43) |
| aggregate | 86 | 77.1% (111/144) | 91.1% (102/112) | 88.1% (74/84) |

## 2026-07-31, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 29 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 10 | 60.0% (3/5) | 100.0% (3/3) | 50.0% (2/4) | 0 |
| hr | 4 | 83.3% (5/6) | 10 | 66.7% (2/3) | 66.7% (2/3) | 60.0% (3/5, 1 FALSE) | 0 |
| aggregate | 9 | 92.9% (13/14) | 20 | 62.5% (5/8) | 83.3% (5/6) | 55.6% (5/9, 1 FALSE) | 0 |

## 2026-07-31, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-07-31, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-07-31, extraction/v0004 + verification/v0006 (thresholds v1, 86 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 42 | 83.1% (59/71) | 94.6% (53/56) | 97.6% (40/41) |
| hr | 44 | 77.5% (55/71) | 92.9% (52/56) | 81.4% (35/43) |
| aggregate | 86 | 80.3% (114/142) | 93.8% (105/112) | 89.3% (75/84) |

## 2026-07-31, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 29 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 10 | 75.0% (3/4) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| hr | 4 | 83.3% (5/6) | 10 | 60.0% (3/5) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| aggregate | 9 | 92.9% (13/14) | 20 | 66.7% (6/9) | 100.0% (6/6) | 75.0% (6/8) | 0 |

## 2026-07-31, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-02, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 67% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 71% | PASS | PASS | PASS |  |  |  |  |  | FAIL |

## 2026-08-02, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 33% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-08-02, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 50% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-08-02, extraction/v0004 + verification/v0006 (thresholds v1, 86 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 42 | 82.2% (60/73) | 94.6% (53/56) | 97.6% (40/41) |
| hr | 44 | 78.1% (57/73) | 92.9% (52/56) | 83.7% (36/43) |
| aggregate | 86 | 80.1% (117/146) | 93.8% (105/112) | 90.5% (76/84) |

## 2026-08-02, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 29 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 10 | 75.0% (3/4) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| hr | 4 | 83.3% (5/6) | 10 | 60.0% (3/5) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| aggregate | 9 | 92.9% (13/14) | 20 | 66.7% (6/9) | 100.0% (6/6) | 75.0% (6/8) | 0 |

## 2026-08-02, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-02, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 33% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-08-02, extraction/v0004 + verification/v0006 (thresholds v1, 86 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 42 | 81.9% (59/72) | 94.6% (53/56) | 97.6% (40/41) |
| hr | 44 | 76.7% (56/73) | 91.1% (51/56) | 86.0% (37/43) |
| aggregate | 86 | 79.3% (115/145) | 92.9% (104/112) | 91.7% (77/84) |

## 2026-08-02, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 29 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 10 | 60.0% (3/5) | 100.0% (3/3) | 50.0% (2/4) | 0 |
| hr | 4 | 83.3% (5/6) | 10 | 60.0% (3/5) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| aggregate | 9 | 92.9% (13/14) | 20 | 60.0% (6/10) | 100.0% (6/6) | 62.5% (5/8) | 0 |

## 2026-08-02, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-02, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 50% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | FAIL | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 29% | PASS | PASS | PASS |  |  |  |  |  | FAIL |

## 2026-08-02, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 33% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-08-02, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 67% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 0% |  | PASS | PASS |  | FAIL |  |  |  | FAIL |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-08-02, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 14% | PASS | PASS | PASS |  |  |  |  |  | FAIL |

**Note on the two runs above (V2.0 item 3.7, back to back, identical code).** They
are recorded because they are the clearest evidence yet that the live chat gate is
a coin flip at this corpus size, and the rule is that a dip ships with its
explanation rather than being re-run away.

Same commit, same configuration, minutes apart:

| | run 1 | run 2 |
|---|---|---|
| rule checks | FAIL (`previously_decided`, `strict_mode_hr`, both temporal) | all PASS |
| `who_is_ana` coverage | 86% | 14% |
| `atlas_scope` coverage | 67% | 83% |
| `previously_decided` coverage | 0% | 100% |
| mean coverage (gate 65%) | 63.3% | 74.3% |

Run 1 would have failed the gate on both arms; run 2 clears both comfortably. The
swing is model-side, not code-side: only four cases are coverage-graded, so one
case moving takes the mean across the floor on its own, and `previously_decided`
retrieved one fact in run 1 and both in run 2 for the same query against the same
seeded corpus. Nothing in item 3.7 touches retrieval, query rewrite or the answer
prompt, and the harness builds its gateway with neither the budget nor the new
egress decorator, so it cannot be implicated.

This is the same root cause already recorded for the caching decision in
[`docs/eval-golden-set.md`](../eval-golden-set.md) §6: retrieval returns equally
scored facts in a different order every run, so the answer prompt differs run to
run even when the model does not. The stable ordering tiebreak that fixes it is
the follow-up in [`website-follow-up.md`](website-follow-up.md); until it lands,
a red live chat gate on `main` needs a second run before it is believed, and the
four-case coverage mean is too small a denominator to gate honestly.

## 2026-08-03, extraction/v0004 + verification/v0006 (thresholds v1, 96 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 47 | 81.7% (76/93) | 93.2% (69/74) | 97.8% (45/46) |
| hr | 49 | 83.3% (70/84) | 89.2% (66/74) | 85.4% (41/48) |
| aggregate | 96 | 82.5% (146/177) | 91.2% (135/148) | 91.5% (86/94) |

## 2026-08-03, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 29 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 10 | 75.0% (3/4) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| hr | 4 | 83.3% (5/6) | 10 | 75.0% (3/4) | 100.0% (3/3) | 100.0% (4/4) | 0 |
| aggregate | 9 | 92.9% (13/14) | 20 | 75.0% (6/8) | 100.0% (6/6) | 87.5% (7/8) | 0 |

## 2026-08-03, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-03, extraction/v0004 + verification/v0006 (thresholds v1, 96 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 47 | 82.6% (76/92) | 94.3% (66/70) | 100.0% (46/46) |
| hr | 49 | 85.5% (71/83) | 94.3% (66/70) | 85.4% (41/48) |
| aggregate | 96 | 84.0% (147/175) | 94.3% (132/140) | 92.6% (87/94) |

## 2026-08-03, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 29 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 10 | 75.0% (3/4) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| hr | 4 | 83.3% (5/6) | 10 | 60.0% (3/5) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| aggregate | 9 | 92.9% (13/14) | 20 | 66.7% (6/9) | 100.0% (6/6) | 75.0% (6/8) | 0 |

## 2026-08-03, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 75.0% (12/16) |
| aggregate | 32 | 87.5% (28/32) |

## 2026-08-03, extraction/v0004 + verification/v0006 (thresholds v1, 96 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 47 | 82.6% (76/92) | 94.3% (66/70) | 95.7% (44/46) |
| hr | 49 | 81.7% (67/82) | 90.0% (63/70) | 83.3% (40/48) |
| aggregate | 96 | 82.2% (143/174) | 92.1% (129/140) | 89.4% (84/94) |

## 2026-08-03, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 29 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 5 | 100.0% (8/8) | 10 | 75.0% (3/4) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| hr | 4 | 83.3% (5/6) | 10 | 60.0% (3/5) | 100.0% (3/3) | 75.0% (3/4) | 0 |
| aggregate | 9 | 92.9% (13/14) | 20 | 66.7% (6/9) | 100.0% (6/6) | 75.0% (6/8) | 0 |

## 2026-08-03, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-03, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0007 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 67% |  | PASS | PASS |  |  |  |  |  | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 29% | PASS | PASS | PASS |  |  |  |  |  | FAIL |

### Note on the three golden runs of 2026-08-03

All three are real live runs made while landing V2.1 item 4.1 (the reading layer),
and they are kept rather than pruned because each measured something different.

1. The first run is the ten new spreadsheet cases labelled **one expected memory per
   column pair**. It passed every gate, and it exposed a labelling flaw rather than a
   system one: `en` split each ledger row into two facts and `hr` merged the identical
   row into one, so the same content scored differently in the two languages.
2. The second run is those cases relabelled **one `must_extract` per row**, with the
   column splits beside them as `must_extract: false`.
3. The third is a re-record of the second. The second run's cache had silently lost
   one query-rewrite entry: a model call failed mid-run and `rewriteQuery` swallows
   the error, so nothing was recorded for `hr-rw09` and the replay then scored it as a
   failure for the wrong reason. **Always run `eval:cached` after a refresh and check
   for `CACHE MISS`.** The third run is the one the committed fixtures came from.

No gate was lowered or raised in any of them.

## 2026-08-04, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 82.5% (80/97) | 93.2% (69/74) | 95.7% (45/47) |
| hr | 50 | 81.5% (75/92) | 93.2% (69/74) | 87.5% (42/48) |
| aggregate | 98 | 82.0% (155/189) | 93.2% (138/148) | 91.6% (87/95) |

## 2026-08-04, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 33 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 11 | 60.0% (3/5) | 100.0% (3/3) | 50.0% (2/4) | 1 |
| hr | 5 | 87.5% (7/8) | 11 | 60.0% (3/5) | 100.0% (3/3) | 75.0% (3/4) | 1 |
| aggregate | 11 | 94.4% (17/18) | 22 | 60.0% (6/10) | 100.0% (6/6) | 62.5% (5/8) | 2 |

## 2026-08-04, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-04, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 84.2% (80/95) | 95.9% (71/74) | 91.5% (43/47) |
| hr | 50 | 77.6% (76/98) | 94.6% (70/74) | 89.6% (43/48) |
| aggregate | 98 | 80.8% (156/193) | 95.3% (141/148) | 90.5% (86/95) |

## 2026-08-04, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 33 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 11 | 75.0% (3/4) | 100.0% (3/3) | 75.0% (3/4) | 1 |
| hr | 5 | 87.5% (7/8) | 11 | 75.0% (3/4) | 100.0% (3/3) | 100.0% (4/4) | 1 |
| aggregate | 11 | 94.4% (17/18) | 22 | 75.0% (6/8) | 100.0% (6/6) | 87.5% (7/8) | 2 |

## 2026-08-04, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-04, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 82.3% (79/96) | 93.2% (69/74) | 95.7% (45/47) |
| hr | 50 | 80.6% (75/93) | 91.9% (68/74) | 91.7% (44/48) |
| aggregate | 98 | 81.5% (154/189) | 92.6% (137/148) | 93.7% (89/95) |

## 2026-08-04, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 33 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 11 | 60.0% (3/5) | 100.0% (3/3) | 50.0% (2/4) | 1 |
| hr | 5 | 87.5% (7/8) | 11 | 50.0% (2/4) | 66.7% (2/3) | 60.0% (3/5, 1 FALSE) | 1 |
| aggregate | 11 | 94.4% (17/18) | 22 | 55.6% (5/9) | 83.3% (5/6) | 55.6% (5/9, 1 FALSE) | 2 |

## 2026-08-04, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-04, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 83.5% (76/91) | 90.5% (67/74) | 93.6% (44/47) |
| hr | 50 | 78.5% (73/93) | 89.2% (66/74) | 87.5% (42/48) |
| aggregate | 98 | 81.0% (149/184) | 89.9% (133/148) | 90.5% (86/95) |

## 2026-08-04, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 33 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 11 | 75.0% (3/4) | 100.0% (3/3) | 75.0% (3/4) | 1 |
| hr | 5 | 87.5% (7/8) | 11 | 75.0% (3/4) | 100.0% (3/3) | 75.0% (3/4) | 1 |
| aggregate | 11 | 94.4% (17/18) | 22 | 75.0% (6/8) | 100.0% (6/6) | 75.0% (6/8) | 2 |

## 2026-08-04, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-04, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 84.5% (82/97) | 94.6% (70/74) | 93.6% (44/47) |
| hr | 50 | 82.2% (74/90) | 89.2% (66/74) | 89.6% (43/48) |
| aggregate | 98 | 83.4% (156/187) | 91.9% (136/148) | 91.6% (87/95) |

## 2026-08-04, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v1, 33 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 11 | 60.0% (3/5) | 100.0% (3/3) | 50.0% (2/4) | 1 |
| hr | 5 | 87.5% (7/8) | 11 | 60.0% (3/5) | 100.0% (3/3) | 75.0% (3/4) | 1 |
| aggregate | 11 | 94.4% (17/18) | 22 | 60.0% (6/10) | 100.0% (6/6) | 62.5% (5/8) | 2 |

## 2026-08-04, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-07, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 82.7% (81/98) | 93.2% (69/74) | 95.7% (45/47) |
| hr | 50 | 80.2% (73/91) | 89.2% (66/74) | 91.7% (44/48) |
| aggregate | 98 | 81.5% (154/189) | 91.2% (135/148) | 93.7% (89/95) |

## 2026-08-07, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 53.8% (7/13) | 100.0% (7/7) | 20.0% (1/5) | 1 |
| hr | 5 | 87.5% (7/8) | 21 | 58.3% (7/12) | 100.0% (7/7) | 25.0% (1/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 56.0% (14/25) | 100.0% (14/14) | 22.2% (2/9) | 3 |

## 2026-08-07, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 75.0% (12/16) |
| aggregate | 32 | 87.5% (28/32) |

## 2026-08-07, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 82.5% (80/97) | 93.2% (69/74) | 93.6% (44/47) |
| hr | 50 | 80.9% (76/94) | 93.2% (69/74) | 85.4% (41/48) |
| aggregate | 98 | 81.7% (156/191) | 93.2% (138/148) | 89.5% (85/95) |

## 2026-08-07, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 77.8% (7/9) | 100.0% (7/7) | 40.0% (2/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 75.0% (6/8) | 85.7% (6/7) | 50.0% (2/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 76.5% (13/17) | 92.9% (13/14) | 44.4% (4/9) | 4 |

## 2026-08-07, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-07, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 83.2% (79/95) | 93.2% (69/74) | 95.7% (45/47) |
| hr | 50 | 80.4% (78/97) | 95.9% (71/74) | 89.6% (43/48) |
| aggregate | 98 | 81.8% (157/192) | 94.6% (140/148) | 92.6% (88/95) |

## 2026-08-07, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 77.8% (7/9) | 100.0% (7/7) | 60.0% (3/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 87.5% (7/8) | 100.0% (7/7) | 75.0% (3/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 82.4% (14/17) | 100.0% (14/14) | 66.7% (6/9) | 4 |

## 2026-08-07, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-07, chat eval (configuration=mistral-default--vis-mistral-pixtral-12b-2409 · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0008 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | FAIL | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 0% | PASS | PASS | PASS |  |  |  |  |  | FAIL |

## 2026-08-07, chat eval (configuration=mistral-default--vis-mistral-pixtral-12b-2409 · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0008 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS |

## 2026-08-07, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0008 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | ambiguity | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ambiguity_cap_en |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_hr | PASS |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_followup_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_hr | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_silent_en |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_silent_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_weak_dominance_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS |  | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS |  | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS |  | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS |  | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS | PASS |

ambiguity branches over 42 turn(s): dominant=11 silent=6 fan_out=4 none=21 · fan-out rate 9.5%

## 2026-08-07, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0008 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | ambiguity | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ambiguity_cap_en |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_hr | PASS |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_followup_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_hr | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_silent_en |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_silent_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_weak_dominance_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| atlas_scope |  | 33% |  | PASS | PASS |  |  |  |  |  | FAIL | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS |  | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS |  | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS |  | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS |  | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS | PASS |

ambiguity branches over 42 turn(s): dominant=11 silent=5 fan_out=5 none=21 · fan-out rate 11.9%

## 2026-08-07, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0008 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | ambiguity | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ambiguity_cap_en |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_hr | PASS |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_followup_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_hr | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_silent_en |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_silent_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_weak_dominance_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| atlas_scope |  | 50% |  | PASS | PASS |  |  |  |  |  | PASS | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS |  | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  |  | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS |  | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS |  | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS |  | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS | PASS |

ambiguity branches over 42 turn(s): dominant=12 silent=5 fan_out=4 none=21 · fan-out rate 9.5%

## 2026-08-07, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 100.0% (0/0) | 0.0% (0/74) | 100.0% (0/0) |
| hr | 50 | 100.0% (0/0) | 0.0% (0/74) | 100.0% (0/0) |
| aggregate | 98 | 100.0% (0/0) | 0.0% (0/148) | 100.0% (0/0) |

## 2026-08-07, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 80.0% (8/10) | 22 | 100.0% (0/0) | 0.0% (0/7) | 0.0% (0/5) | 28 |
| hr | 5 | 75.0% (6/8) | 21 | 100.0% (0/0) | 0.0% (0/7) | 0.0% (0/4) | 26 |
| aggregate | 11 | 77.8% (14/18) | 43 | 100.0% (0/0) | 0.0% (0/14) | 0.0% (0/9) | 54 |

## 2026-08-07, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 50.0% (8/16) |
| hr | 16 | 43.8% (7/16) |
| aggregate | 32 | 46.9% (15/32) |

## 2026-08-07, VERTICAL corpus (real documents, 20 cases + 23 pairs)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 12 | 100.0% (0/0) | 0.0% (0/111) | 100.0% (0/0) |
| hr | 8 | 100.0% (0/0) | 0.0% (0/62) | 100.0% (0/0) |
| aggregate | 20 | 100.0% (0/0) | 0.0% (0/173) | 100.0% (0/0) |

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 66.7% (4/6) | 8 | 100.0% (0/0) | 100.0% (0/0) | 0.0% (0/2) | 12 |
| hr | 2 | 100.0% (4/4) | 5 | 100.0% (0/0) | 100.0% (0/0) | 0.0% (0/2) | 7 |
| xl | 1 | 0.0% (0/1) | 3 | 100.0% (0/0) | 0.0% (0/1) | 0.0% (0/1) | 4 |
| aggregate | 7 | 72.7% (8/11) | 16 | 100.0% (0/0) | 0.0% (0/1) | 0.0% (0/5) | 23 |

## 2026-08-07, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 82.5% (80/97) | 93.2% (69/74) | 95.7% (45/47) |
| hr | 50 | 84.3% (75/89) | 91.9% (68/74) | 89.6% (43/48) |
| aggregate | 98 | 83.3% (155/186) | 92.6% (137/148) | 92.6% (88/95) |

## 2026-08-07, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 77.8% (7/9) | 100.0% (7/7) | 60.0% (3/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 87.5% (7/8) | 100.0% (7/7) | 75.0% (3/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 82.4% (14/17) | 100.0% (14/14) | 66.7% (6/9) | 4 |

## 2026-08-07, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-07, VERTICAL corpus (real documents, 20 cases + 24 pairs)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 12 | 51.0% (106/208) | 95.5% (106/111) | 91.7% (11/12) |
| hr | 8 | 47.7% (53/111) | 85.5% (53/62) | 71.4% (5/7) |
| aggregate | 20 | 49.8% (159/319) | 91.9% (159/173) | 84.2% (16/19) |

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 8 | 0.0% (0/2) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| hr | 2 | 50.0% (2/4, 1 FALSE MERGE) | 5 | 0.0% (0/1) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| xl | 1 | 100.0% (1/1) | 4 | 100.0% (0/0) | 0.0% (0/2) | 0.0% (0/1) | 1 |
| aggregate | 7 | 81.8% (9/11, 1 FALSE MERGE) | 17 | 0.0% (0/3) | 0.0% (0/2) | 0.0% (0/5) | 7 |

## 2026-08-08, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 84.9% (79/93) | 94.6% (70/74) | 93.6% (44/47) |
| hr | 50 | 78.5% (73/93) | 90.5% (67/74) | 83.3% (40/48) |
| aggregate | 98 | 81.7% (152/186) | 92.6% (137/148) | 88.4% (84/95) |

## 2026-08-08, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 77.8% (7/9) | 100.0% (7/7) | 60.0% (3/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 87.5% (7/8) | 100.0% (7/7) | 75.0% (3/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 82.4% (14/17) | 100.0% (14/14) | 66.7% (6/9) | 4 |

## 2026-08-08, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 62.5% (10/16) |
| aggregate | 32 | 81.3% (26/32) |

## 2026-08-08, VERTICAL corpus (real documents, 20 cases + 24 pairs)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 12 | 54.8% (102/186) | 91.9% (102/111) | 83.3% (10/12) |
| hr | 8 | 51.3% (58/113) | 93.5% (58/62) | 75.0% (6/8) |
| aggregate | 20 | 53.5% (160/299) | 92.5% (160/173) | 80.0% (16/20) |

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 8 | 0.0% (0/2) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| hr | 2 | 50.0% (2/4, 1 FALSE MERGE) | 5 | 0.0% (0/1) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| xl | 1 | 100.0% (1/1) | 4 | 100.0% (0/0) | 0.0% (0/2) | 0.0% (0/1) | 1 |
| aggregate | 7 | 81.8% (9/11, 1 FALSE MERGE) | 17 | 0.0% (0/3) | 0.0% (0/2) | 0.0% (0/5) | 7 |

## 2026-08-08, extraction/v0005 + verification/v0006 (thresholds v1, 98 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 48 | 81.6% (80/98) | 93.2% (69/74) | 95.7% (45/47) |
| hr | 50 | 82.1% (78/95) | 93.2% (69/74) | 85.4% (41/48) |
| aggregate | 98 | 81.9% (158/193) | 93.2% (138/148) | 90.5% (86/95) |

## 2026-08-08, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 75.0% (6/8) | 85.7% (6/7) | 60.0% (3/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 87.5% (7/8) | 100.0% (7/7) | 75.0% (3/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 81.3% (13/16) | 92.9% (13/14) | 66.7% (6/9) | 4 |

## 2026-08-08, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-08, VERTICAL corpus (real documents, 20 cases + 24 pairs)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 12 | 50.5% (101/200) | 91.0% (101/111) | 83.3% (10/12) |
| hr | 8 | 44.9% (57/127) | 91.9% (57/62) | 87.5% (7/8) |
| aggregate | 20 | 48.3% (158/327) | 91.3% (158/173) | 85.0% (17/20) |

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 8 | 0.0% (0/2) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| hr | 2 | 50.0% (2/4, 1 FALSE MERGE) | 5 | 0.0% (0/1) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| xl | 1 | 100.0% (1/1) | 4 | 100.0% (0/0) | 0.0% (0/2) | 0.0% (0/1) | 1 |
| aggregate | 7 | 81.8% (9/11, 1 FALSE MERGE) | 17 | 0.0% (0/3) | 0.0% (0/2) | 0.0% (0/5) | 7 |

## 2026-08-11, extraction/v0006 + verification/v0006 (thresholds v1, 102 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 50 | 86.1% (93/108) | 96.4% (81/84) | 98.0% (48/49) |
| hr | 52 | 79.1% (87/110) | 91.6% (76/83) | 88.0% (44/50) |
| aggregate | 102 | 82.6% (180/218) | 94.0% (157/167) | 92.9% (92/99) |

## 2026-08-11, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 75.0% (6/8) | 85.7% (6/7) | 60.0% (3/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 87.5% (7/8) | 100.0% (7/7) | 75.0% (3/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 81.3% (13/16) | 92.9% (13/14) | 66.7% (6/9) | 4 |

## 2026-08-11, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-11, VERTICAL corpus (real documents, 20 cases + 24 pairs)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 12 | 51.0% (102/200) | 91.9% (102/111) | 91.7% (11/12) |
| hr | 8 | 56.3% (58/103) | 93.5% (58/62) | 87.5% (7/8) |
| aggregate | 20 | 52.8% (160/303) | 92.5% (160/173) | 90.0% (18/20) |

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 8 | 0.0% (0/2) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| hr | 2 | 50.0% (2/4, 1 FALSE MERGE) | 5 | 0.0% (0/1) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| xl | 1 | 100.0% (1/1) | 4 | 100.0% (0/0) | 0.0% (0/2) | 0.0% (0/1) | 1 |
| aggregate | 7 | 81.8% (9/11, 1 FALSE MERGE) | 17 | 0.0% (0/3) | 0.0% (0/2) | 0.0% (0/5) | 7 |

## 2026-08-11, extraction/v0006 + verification/v0006 (thresholds v1, 102 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 50 | 84.4% (92/109) | 95.2% (80/84) | 93.9% (46/49) |
| hr | 52 | 80.2% (89/111) | 94.0% (78/83) | 88.0% (44/50) |
| aggregate | 102 | 82.3% (181/220) | 94.6% (158/167) | 90.9% (90/99) |

## 2026-08-11, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 75.0% (6/8) | 85.7% (6/7) | 60.0% (3/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 75.0% (6/8) | 85.7% (6/7) | 50.0% (2/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 75.0% (12/16) | 85.7% (12/14) | 55.6% (5/9) | 4 |

## 2026-08-11, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-11, VERTICAL corpus (real documents, 20 cases + 24 pairs)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 12 | 49.5% (108/218) | 97.3% (108/111) | 75.0% (9/12) |
| hr | 8 | 54.1% (59/109) | 95.2% (59/62) | 37.5% (3/8) |
| aggregate | 20 | 51.1% (167/327) | 96.5% (167/173) | 60.0% (12/20) |

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 8 | 0.0% (0/2) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| hr | 2 | 50.0% (2/4, 1 FALSE MERGE) | 5 | 0.0% (0/1) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| xl | 1 | 100.0% (1/1) | 4 | 100.0% (0/0) | 0.0% (0/2) | 0.0% (0/1) | 1 |
| aggregate | 7 | 81.8% (9/11, 1 FALSE MERGE) | 17 | 0.0% (0/3) | 0.0% (0/2) | 0.0% (0/5) | 7 |

## 2026-08-11, extraction/v0006 + verification/v0006 (thresholds v1, 102 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 50 | 84.8% (89/105) | 94.0% (79/84) | 95.9% (47/49) |
| hr | 52 | 79.3% (88/111) | 95.2% (79/83) | 92.0% (46/50) |
| aggregate | 102 | 81.9% (177/216) | 94.6% (158/167) | 93.9% (93/99) |

## 2026-08-11, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 75.0% (6/8) | 85.7% (6/7) | 60.0% (3/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 85.7% (6/7) | 85.7% (6/7) | 75.0% (3/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 80.0% (12/15) | 85.7% (12/14) | 66.7% (6/9) | 4 |

## 2026-08-11, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 75.0% (12/16) |
| aggregate | 32 | 87.5% (28/32) |

## 2026-08-11, VERTICAL corpus (real documents, 20 cases + 24 pairs)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 12 | 57.9% (92/159) | 82.9% (92/111) | 80.0% (8/10) |
| hr | 8 | 51.8% (57/110) | 91.9% (57/62) | 62.5% (5/8) |
| aggregate | 20 | 55.4% (149/269) | 86.1% (149/173) | 72.2% (13/18) |

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 8 | 0.0% (0/2) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| hr | 2 | 50.0% (2/4, 1 FALSE MERGE) | 5 | 0.0% (0/1) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| xl | 1 | 100.0% (1/1) | 4 | 100.0% (0/0) | 0.0% (0/2) | 0.0% (0/1) | 1 |
| aggregate | 7 | 81.8% (9/11, 1 FALSE MERGE) | 17 | 0.0% (0/3) | 0.0% (0/2) | 0.0% (0/5) | 7 |

## 2026-08-11, extraction/v0006 + verification/v0006 (thresholds v1, 102 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 50 | 83.6% (92/110) | 94.0% (79/84) | 95.9% (47/49) |
| hr | 52 | 83.7% (87/104) | 94.0% (78/83) | 80.0% (40/50) |
| aggregate | 102 | 83.6% (179/214) | 94.0% (157/167) | 87.9% (87/99) |

## 2026-08-11, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 77.8% (7/9) | 100.0% (7/7) | 60.0% (3/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 87.5% (7/8) | 100.0% (7/7) | 75.0% (3/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 82.4% (14/17) | 100.0% (14/14) | 66.7% (6/9) | 4 |

## 2026-08-11, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-11, VERTICAL corpus (real documents, 20 cases + 24 pairs)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 12 | 49.2% (88/179) | 79.3% (88/111) | 80.0% (8/10) |
| hr | 8 | 54.9% (56/102) | 90.3% (56/62) | 62.5% (5/8) |
| aggregate | 20 | 51.2% (144/281) | 83.2% (144/173) | 72.2% (13/18) |

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 8 | 0.0% (0/2) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| hr | 2 | 50.0% (2/4, 1 FALSE MERGE) | 5 | 0.0% (0/1) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| xl | 1 | 100.0% (1/1) | 4 | 100.0% (0/0) | 0.0% (0/2) | 0.0% (0/1) | 1 |
| aggregate | 7 | 81.8% (9/11, 1 FALSE MERGE) | 17 | 0.0% (0/3) | 0.0% (0/2) | 0.0% (0/5) | 7 |

## 2026-08-11, extraction/v0006 + verification/v0006 (thresholds v1, 102 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 50 | 80.7% (92/114) | 94.0% (79/84) | 91.8% (45/49) |
| hr | 52 | 80.6% (87/108) | 95.2% (79/83) | 88.0% (44/50) |
| aggregate | 102 | 80.6% (179/222) | 94.6% (158/167) | 89.9% (89/99) |

## 2026-08-11, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 75.0% (6/8) | 85.7% (6/7) | 60.0% (3/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 85.7% (6/7) | 85.7% (6/7) | 75.0% (3/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 80.0% (12/15) | 85.7% (12/14) | 66.7% (6/9) | 4 |

## 2026-08-11, query_rewrite/v0006 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 81.3% (13/16) |
| aggregate | 32 | 90.6% (29/32) |

## 2026-08-11, VERTICAL corpus (real documents, 20 cases + 24 pairs)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 12 | 53.0% (105/198) | 94.6% (105/111) | 75.0% (9/12) |
| hr | 8 | 48.7% (55/113) | 88.7% (55/62) | 75.0% (6/8) |
| aggregate | 20 | 51.4% (160/311) | 92.5% (160/173) | 75.0% (15/20) |

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 8 | 0.0% (0/2) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| hr | 2 | 50.0% (2/4, 1 FALSE MERGE) | 5 | 0.0% (0/1) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| xl | 1 | 100.0% (1/1) | 4 | 100.0% (0/0) | 0.0% (0/2) | 0.0% (0/1) | 1 |
| aggregate | 7 | 81.8% (9/11, 1 FALSE MERGE) | 17 | 0.0% (0/3) | 0.0% (0/2) | 0.0% (0/5) | 7 |

## 2026-08-13, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0009 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | ambiguity | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ambiguity_cap_en |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_hr | PASS |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_followup_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_hr | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_silent_en |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_silent_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_weak_dominance_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| atlas_scope |  | 50% |  | PASS | PASS |  |  |  |  |  | PASS | FAIL |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS |  | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  |  | PASS |
| followup_focus_after_digression_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| followup_two_visual_subjects_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS |  | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS |  | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS |  | PASS |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| who_is_ana | PASS | 86% | PASS | PASS | PASS |  |  |  |  |  | PASS | PASS |

ambiguity branches over 47 turn(s): dominant=16 silent=5 fan_out=4 none=22 · fan-out rate 8.5%

## 2026-08-16, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0009 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | ambiguity | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ambiguity_cap_en |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_hr | PASS |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_followup_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_hr | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_silent_en |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_silent_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_weak_dominance_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS |  | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  |  | PASS |
| followup_focus_after_digression_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| followup_two_visual_subjects_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS |  | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS |  | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | FAIL |  | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| who_is_ana | PASS | 71% | PASS | PASS | PASS |  |  |  |  |  | PASS | FAIL |

ambiguity branches over 47 turn(s): dominant=16 silent=5 fan_out=4 none=22 · fan-out rate 8.5%

## 2026-08-19, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0009 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | ambiguity | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ambiguity_cap_en |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_hr | PASS |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_followup_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_hr | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_silent_en |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_silent_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_weak_dominance_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS |  | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  |  | PASS |
| followup_focus_after_digression_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| followup_two_visual_subjects_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS |  | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS |  | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS |  | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| who_is_ana | PASS | 71% | PASS | PASS | PASS |  |  |  |  |  | PASS | FAIL |

ambiguity branches over 47 turn(s): dominant=16 silent=5 fan_out=4 none=22 · fan-out rate 8.5%

## 2026-08-19, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0009 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | ambiguity | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ambiguity_cap_en |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_hr | PASS |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_followup_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_hr | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_silent_en |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_silent_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_weak_dominance_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS |  | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  |  | PASS |
| followup_focus_after_digression_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| followup_two_visual_subjects_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS |  | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS |  | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS |  | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| who_is_ana | PASS | 71% | PASS | PASS | PASS |  |  |  |  |  | PASS | FAIL |

ambiguity branches over 47 turn(s): dominant=16 silent=5 fan_out=4 none=22 · fan-out rate 8.5%

## 2026-08-19, chat eval (configuration=mistral-default · pipeline=mistral/mistral-small-latest · answer=mistral/mistral-medium-latest · answer-prompt=answer/v0009 · grader=mistral/mistral-medium-latest eval-coverage/v0001)

| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | ambiguity | overall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ambiguity_cap_en |  |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fanout_cold_hr | PASS |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_followup_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_fragment_hr | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| ambiguity_silent_en |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_silent_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| ambiguity_weak_dominance_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| atlas_scope |  | 83% |  | PASS | PASS |  |  |  |  |  | PASS | PASS |
| blended_origins_en | PASS | 100% |  | PASS | PASS |  | PASS |  |  | PASS | PASS | PASS |
| changed_since |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| default_no_time_travel |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| digest_hr_preferred |  |  |  |  |  |  |  |  |  | PASS |  | PASS |
| followup_cross_capability |  |  |  | PASS | PASS |  | PASS | PASS |  |  |  | PASS |
| followup_focus_after_digression_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| followup_two_visual_subjects_en | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| knowledge_offer_en |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| knowledge_offer_hr |  |  |  | PASS | PASS |  | PASS |  |  | PASS |  | PASS |
| memory_beats_model | PASS |  |  | PASS | PASS |  | PASS |  |  |  | PASS | PASS |
| nothing_on_record |  |  |  |  |  | PASS |  |  |  |  | PASS | PASS |
| open_with_entity |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| point_in_time_march |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| previously_decided |  | 100% |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| reply_hr_zadnja |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| reply_to_ana |  |  |  |  |  |  | PASS |  |  |  |  | PASS |
| research_keeps_subject_hr |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| research_minimise_drop |  |  |  | PASS |  |  | PASS | PASS |  |  |  | PASS |
| skill_brief_en |  |  |  | PASS |  |  | PASS |  | PASS |  |  | PASS |
| skill_brief_hr |  |  |  | PASS |  |  | PASS |  | PASS | PASS |  | PASS |
| smalltalk_hvala_hr |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| smalltalk_thanks |  |  |  | PASS | PASS |  |  |  |  | PASS |  | PASS |
| strict_mode_hr |  |  |  | PASS | PASS |  | FAIL |  |  | PASS |  | FAIL |
| whats_still_open |  |  |  | PASS | PASS |  | PASS |  |  |  |  | PASS |
| who_is_ana | PASS | 43% | PASS | PASS | PASS |  |  |  |  |  | PASS | FAIL |

ambiguity branches over 47 turn(s): dominant=16 silent=5 fan_out=4 none=22 · fan-out rate 8.5%

## 2026-08-22, extraction/v0006 + verification/v0006 (thresholds v1, 102 cases)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 50 | 83.6% (92/110) | 96.4% (81/84) | 93.9% (46/49) |
| hr | 52 | 83.5% (86/103) | 94.0% (78/83) | 86.0% (43/50) |
| aggregate | 102 | 83.6% (178/213) | 95.2% (159/167) | 89.9% (89/99) |

## 2026-08-22, reconcile_dedup/v0001 + reconcile_contradiction/v0001 (reconcile-config v2, 54 pairs)

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 6 | 100.0% (10/10) | 22 | 75.0% (6/8) | 85.7% (6/7) | 60.0% (3/5) | 2 |
| hr | 5 | 87.5% (7/8) | 21 | 87.5% (7/8) | 100.0% (7/7) | 75.0% (3/4) | 2 |
| aggregate | 11 | 94.4% (17/18) | 43 | 81.3% (13/16) | 92.9% (13/14) | 66.7% (6/9) | 4 |

## 2026-08-22, query_rewrite/v0007 (query-rewrite routing, 32 cases)

| set | cases | routing accuracy |
|---|---|---|
| en | 16 | 100.0% (16/16) |
| hr | 16 | 75.0% (12/16) |
| aggregate | 32 | 87.5% (28/32) |

## 2026-08-22, VERTICAL corpus (real documents, 20 cases + 24 pairs)

| set | cases | extraction precision | extraction recall | verification agreement |
|---|---|---|---|---|
| en | 12 | 50.7% (108/213) | 97.3% (108/111) | 91.7% (11/12) |
| hr | 8 | 48.3% (56/116) | 90.3% (56/62) | 87.5% (7/8) |
| aggregate | 20 | 49.8% (164/329) | 94.8% (164/173) | 90.0% (18/20) |

| set | dedup pairs | dedup accuracy | contra pairs | contra precision | contra recall | supersedes accuracy | candidate misses |
|---|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 8 | 0.0% (0/2) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| hr | 2 | 50.0% (2/4, 1 FALSE MERGE) | 5 | 0.0% (0/1) | 100.0% (0/0) | 0.0% (0/2) | 3 |
| xl | 1 | 100.0% (1/1) | 4 | 100.0% (0/0) | 0.0% (0/2) | 0.0% (0/1) | 1 |
| aggregate | 7 | 81.8% (9/11, 1 FALSE MERGE) | 17 | 0.0% (0/3) | 0.0% (0/2) | 0.0% (0/5) | 7 |
