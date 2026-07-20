# Experiment: mistral-large-latest as the pipeline model

Date: 2026-07-20 · Branch: `experiment/pipeline-mistral-large` · Status: complete

## Question

Does a smarter (and more expensive) model on the **pipeline tier** — extraction,
verification, dedup, contradiction, task logic — measurably improve Cogeto's
memory quality? The **answer tier and the chat grader stay at their defaults**
(`mistral-medium-latest`, grader `eval-coverage/v0001`), so chat results measure
only the effect of better-extracted memories, never a changed judge.

## Setup

| | value |
|---|---|
| Experiment config | pipeline `mistral-large-latest` · answer `mistral-medium-latest` · embed `mistral-embed` (trust-scores id: `mistral-custom`) |
| Baseline config | pipeline `mistral-small-latest` · answer `mistral-medium-latest` (id: `mistral-default`) |
| Corpus | 68 golden cases (33 en / 35 hr) · 20 reconcile pairs · 12 chat cases · 12 task-closure + 4 condition pairs |
| Harness | `npm run eval` / `npm run eval:chat` at commit `2445df1` (v1.0.5 line); prompts extraction/v0002, task_closure/v0001, task_condition/v0001, answer/v0004, eval-coverage/v0001 |
| Override | `COGETO_MISTRAL_MODEL_PIPELINE=mistral-large-latest` (note: this variable outranks `MISTRAL_MODEL_PIPELINE`; a first attempt exported only the latter while `.env` pinned the former, and silently measured the default config — caught by checking the emitted partial's `configuration.id`) |
| Machine-readable results | `2026-07-20-pipeline-large-partial.json` (experiment) · `2026-07-20-default-baseline-partial.json` (same-day baseline) · full per-case tables appended to `docs/eval/history.md` |

## Baseline variance (measured, not assumed)

The botched first attempt produced a bonus: a second full default-config run,
one day after the previous one, quantifying run-to-run variance of the live
harness on identical configuration:

| metric | 2026-07-19 baseline | 2026-07-20 baseline | observed variance |
|---|---|---|---|
| extraction_precision | 84.0% | 82.4% | ±1.6pt |
| extraction_recall | 90.0% | 90.0% | 0 |
| verification_agreement | 92.4% | 89.2% | ±3.2pt |
| dedup_accuracy | 92.9% | 92.9% | 0 |
| contradiction_recall | 100% | 100% | 0 |
| chat overall | 10/12 | 11/12 | the documented coverage-grader variance (atlas_scope 33→67, who_is_ana 14→86) |

A model effect is only believable if it exceeds these bands.

## Results — golden set (pipeline tier, programmatically graded)

| metric | default (best of 2 runs) | mistral-large pipeline | delta vs band |
|---|---|---|---|
| extraction_precision | 84.0% | **86.0%** | +2.0pt — at/just above the ±1.6 band: weak positive |
| extraction_recall | 90.0% (stable across both runs) | **93.3%** | **+3.3pt against a zero-variance metric: real improvement** |
| verification_agreement | 92.4% | 89.4% | within ±3.2 band: no effect |
| dedup_accuracy | 92.9% | 92.9% | identical |
| contradiction_recall | 100% | 100% | identical |
| task closure/condition | 100% | 100% | identical |

Per-language (large run): en precision 89.8 / recall 95.6; hr precision 82.4 /
recall 91.1 — the recall gain shows in both languages; Croatian remains the
harder set on every metric.

## Results — chat (12 cases; answer model and grader unchanged)

**Not completed — blocked by an API tier limit.** The account's rate limit
for `mistral-large-latest` is **4 requests/minute** (vs far higher caps on
small/medium). The chat eval's seeding phase bursts pipeline extraction calls
and exhausted the gateway's bounded 429 retries; the golden-set run survived
only because its calls pace out more slowly. Getting chat-with-large numbers
requires either a higher Mistral tier or rate-limit-aware pacing in the eval
harness (neither attempted here; noted as follow-ups).

## Conclusions

1. **The one real quality gain from mistral-large on the pipeline tier is
   extraction recall: 90.0% → 93.3%** — measured against a metric that showed
   zero variance across two baseline runs. The larger model misses fewer
   facts.
2. Precision improved weakly (+2.0pt, at the edge of the ±1.6pt variance
   band); verification, dedup, contradiction, and task logic showed no
   effect. The verification pass and the deterministic logic tasks are not
   the bottleneck a bigger model relieves.
3. **Run-to-run variance of the live harness is material** (±1.6pt precision,
   ±3.2pt verification between identical runs) — single-run comparisons on
   these metrics are not evidence. Publishing any model comparison should
   state the band or use multi-run averages.
4. **Operational**: mistral-large is rate-limited to 4 req/min on the current
   account tier — production use of large on the pipeline would need a tier
   upgrade, and the eval harness needs pacing before it can even measure
   chat-with-large.
5. Verdict for now: the recall gain is real but modest; combined with the
   cost multiple and the rate limit, **not** worth switching the default
   pipeline tier today. Worth revisiting if extraction recall becomes the
   binding quality constraint, with a paced harness and a higher API tier.

## Cost note

Four full suite runs were spent (2 accidental baseline, 2 experiment). The
large-pipeline runs bill at mistral-large rates on the pipeline calls only;
answer/grader calls stayed at default rates in all runs.
