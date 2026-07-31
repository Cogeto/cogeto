# The v1.1.0 extraction-precision drop

*Decision record, written late. Owner: Ivan Golubic. Written 2026-07-31 as part of
V2.0 item 3.4. It should have been written on 2026-07-25.*

## The rule that was breached

[`docs/eval-golden-set.md`](../eval-golden-set.md) §6:

> A drop of more than 2 points from the previous release needs the same
> justification even when the metric is still above its gate.

Aggregate extraction precision fell **3.7 points** between v1.0.5 and v1.1.0.
No record was written. The number was published honestly, in
`eval/trust-scores/v1.1.0.json`, and then nobody said anything about it, which
is the half of honesty that is easy to skip.

## What was measured

| | v1.0.5 (2026-07-20) | v1.1.0 (2026-07-25) | Change |
|---|---|---|---|
| Golden cases | 68 (en 33, hr 35) | 76 (en 37, hr 39) | +8 |
| Extraction precision, aggregate | 0.827 | 0.789 | **-3.7 pts** |
| Extraction precision, en | 0.878 | 0.846 | -3.1 pts |
| Extraction precision, hr | 0.782 | 0.735 | -4.7 pts |
| Extraction recall, aggregate | 0.922 | 0.933 | +1.1 pts |
| Verification agreement, aggregate | 0.848 | 0.865 | +1.7 pts |

Source: `eval/trust-scores/v1.0.5.json` and `eval/trust-scores/v1.1.0.json`.

Recall and verification agreement went **up** across the same window. Whatever
happened cost precision specifically.

## What changed in that release

Everything the metric depends on, checked against the record:

| Input | v1.0.5 | v1.1.0 |
|---|---|---|
| Extraction prompt | `extraction/v0002` | `extraction/v0002` |
| Verification prompt | `verification/v0004` | `verification/v0004` |
| Matching thresholds | v1 | v1 |
| Models | mistral-small / mistral-medium / mistral-embed | identical |
| Golden corpus | 68 cases | **76 cases** |

The corpus is the only input that moved. The eight added cases, four per
language, were:

- `en-e004` / `hr-e004`: the user's own emailed reply, one commitment in the
  new content and another in the quoted history (PR #243).
- `en-f001` / `hr-f001`: an uploaded contract's extracted text, dense with
  obligation language (PR #243).
- `en-w002` / `hr-w002`: a fetched web page, likewise dense with obligation
  language (PR #243).
- `en-w001` / `hr-w001`: a fetched supplier-terms page (PR #188).

## The cause, stated honestly

**The most likely cause is the corpus expansion, not a quality regression, and
it cannot be proven from the record.**

Three of the four added shapes are precision traps by construction. They are
written to be thick with obligation language and labelled with few
`must_extract` memories, because their whole point is that a diligent assistant
would *not* note most of what they say. Precision is matched facts over all
extracted facts, so every fact the extractor produces beyond the sparse labels
is a precision miss by definition. Adding hard negatives to a corpus lowers
precision even when the extractor has not changed by one token, and here the
extractor demonstrably had not: same prompt version, same model.

What cannot be done is to prove it. The evaluation history records per-language
totals, not per-case outcomes, so the old 68-case subset cannot be re-scored
out of the v1.1.0 run. Re-running v1.1.0's code against the 68-case corpus today
would measure today's models, not that release's. **The attribution above is a
reconstruction the record supports, not a measurement.** It is stated as such
rather than dressed up as one.

## Accepted, and partly recovered

**Accepted at the time**, implicitly and without saying so: the number stayed
far above its 0.70 gate and no build failed. That is precisely why the rule
exists, and precisely how it got skipped.

**Partly recovered since.** `extraction/v0003` then `v0004` and
`verification/v0005` then `v0006` shipped, and the corpus grew again to 86
cases. v1.4.0 measured aggregate precision **0.813**, which is 2.4 points back
of the 3.7 lost. It is not a like-for-like comparison and it is not offered as
one: that 0.813 is measured on a corpus 26% larger and deliberately harder than
the one that produced 0.827. The specification target of 0.85 remains unmet, and
[`gate-model.md`](gate-model.md) records the current floor, the target, and the
work that closes the gap.

## What changes so it does not happen again

1. **Per-language floors** (V2.0 item 3.4). The Croatian half of this drop, 4.7
   points, was the larger one and was invisible in the aggregate. Each language
   is now gated at its own honest floor.
2. **A corpus change that moves a headline metric is justified in the pull
   request that makes it**, exactly like a gate change. Adding hard cases is
   good and lowers metrics; that is not a reason to say nothing. The corpus
   `CHANGELOG.md` already required a line per label change, but a line about
   *what the case is* is not a line about *what it did to the number*.
3. **Evals on pull requests** (V2.0 item 3.4). The measurement now happens
   before the merge, where the person making the change is still holding it,
   rather than post-merge on `main`.
