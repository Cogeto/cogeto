# Follow-ups from V2.0 item 3.4

Two, both discovered by this work and both deliberately left out of it.

## 1. Stable ordering for equally scored facts (product repository)

The chat suite cannot be cached, and therefore cannot run on pull requests,
because the answer prompt embeds retrieved facts in retrieval order and
**equally scored facts come back in a different order on every run**. With every
model response served from the cache and every embedding bit-identical, the same
case still built a different prompt (evidence and diff:
[`../eval-golden-set.md`](../eval-golden-set.md) §6).

**The fix:** a stable tiebreak on equally scored facts in retrieval fusion, keyed
on something content-derived rather than on a per-run row id. Sorting ties by the
claim text is enough. It is a retrieval behaviour change, so it needs its own
live chat run and a fresh recording, which is why it is not folded into a change
about measurement honesty.

**What it unblocks:** the chat suite joins the cached pull-request gate. Until
then it runs live post-merge, exactly as before.

## 2. Render the newly published metrics (website repository)

*Written 2026-07-31 with V2.0 item 3.4.*

### Status

The published artifact carries the new metrics from schema **1.1** on. The
trust page will **not show them** until the change below is made, because it
renders a hardcoded metric list rather than whatever the file contains.

Nothing is broken in the meantime. `lib/trust.ts` accepts any `1.x`
`schema_version`, and `fetchGates()` reads `raw.gates[k]` for the same
hardcoded keys, so the new `per_language` block in `gates.json` is ignored
rather than fatal. The page keeps rendering the five metrics it knows. It is
silently incomplete, which is exactly the condition this item exists to end,
so this is a follow-up and not an optional nicety.

### What to change, precisely

Repository `Cogeto/cogeto-web`.

**1. `lib/trust.ts`, `METRIC_KEYS`.** Add three keys:

```ts
export const METRIC_KEYS = [
  "extraction_precision",
  "extraction_recall",
  "verification_agreement",
  "dedup_accuracy",
  "contradiction_precision",   // new
  "contradiction_recall",
  "supersedes_accuracy",       // new
  "rewrite_accuracy",          // new
] as const;
```

`validateAggregate()` requires every `METRIC_KEYS` entry, and the published
`1.0` files do not carry the three new ones. **Treat the new keys as optional
in both validators** or every historical release is dropped from the page and
the trend lines lose their history. Suggested shape: keep `METRIC_KEYS` as the
render list and validate the three new ones with `isFraction(v[k]) ? ... :
undefined`, rendering a dash where a release predates the metric.

**2. `lib/trust.ts`, `LanguageMetrics` and `Corpus`.** Add, all optional:

| Field | Type | Meaning |
|---|---|---|
| `contradiction_precision` | `number \| null` | Correct contradiction flags / all contradiction flags. Null when the language had no reconciliation pairs. |
| `supersedes_accuracy` | `number \| null` | Correct supersession decisions (verdict **and** direction) over the pairs where supersession was at stake. |
| `supersedes_pairs` | `number \| null` | The denominator behind it. **Render it.** A rate over one case means nothing. |
| `rewrite_accuracy` | `number \| null` | Query-rewrite routing cases passed / all such cases. |
| `reconcile_pairs` | `number` | Per-language, on both `corpus.per_language` and `metrics.per_language`. |
| `rewrite_cases` | `number` | Per-language and on `corpus`. |

**3. Metric labels and one-line explanations** for the chart legend and the
table (`trust.metrics[key].label` in the content layer):

| Key | Label | One-liner |
|---|---|---|
| `contradiction_precision` | Contradiction precision | Of the conflicts Cogeto flags, how many are real conflicts. |
| `supersedes_accuracy` | Supersession accuracy | When one fact replaces an earlier one, how often Cogeto gets both the call and the direction right. |
| `rewrite_accuracy` | Question routing | How often a question is routed to the right kind of answer: the right time window, the right person, the right capability. |

**4. Render `supersedes_pairs` beside `supersedes_accuracy`**, e.g. "60%
(6 of 10 pairs)". This is not decoration. The metric was previously computed
over a single case, and a single-case rate is noise whether it reads 0% or
100%.

**5. Per-language gate floors.** `fetchGates()` currently returns one flat set
of aggregate floors and the charts draw them as target lines. `gates.json` now
also carries `per_language`. When the language filter is set to `en` or `hr`,
draw **that language's** floor, not the aggregate one. Otherwise the chart
shows Croatian dedup at 83% against a 90% line it was never gated by, which
misreads as a failing build.

### The honesty note

Add this copy next to the numbers. Corpus sizes per language are already
rendered by `components/trust/Provenance.tsx`; this is the sentence that has
never been on the page.

> These are the numbers we measured, not the numbers we liked. Every metric
> the harness produces is published here, including the ones below our own
> targets, and a release that dips ships with an explanation rather than
> quietly. The corpus each number was measured on is listed above; where a
> score is computed over a handful of cases we print the count beside it, so
> you can judge how much the percentage is worth.

And, where the gate lines are explained:

> The target lines are the floors our build enforces, not our ambitions. They
> sit at the honest current value of each metric and only ever move up. Where
> that is below the level we are aiming for, the gap is written down.

Link the phrase "written down" to
`https://github.com/Cogeto/cogeto/blob/main/docs/eval/gate-model.md`.

### Verification once done

1. Every release from `v0.8.0` to the newest still appears (the `1.0` files
   must not be dropped by the stricter validator).
2. The newest release shows contradiction precision, supersession accuracy with
   its denominator, and question routing, per language and aggregate.
3. Switching the language filter moves the target lines to that language's
   floors.
4. House style: no em or en dashes in any of the copy above.
