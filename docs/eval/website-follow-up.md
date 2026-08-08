# Eval follow-ups

Work each eval item discovered and deliberately left out of itself, because it
belongs to another repository or needs its own gate run. Two came from V2.0 item
3.4; the third from V2.3 item 6.4.

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

## 3. Distinguish the corpora on the trust page (website repository)

*Written 2026-08-08 with V2.3 item 6.4.*

### Status

The published artifact carries **two measured corpora** from schema **1.2** on,
under `configurations[].corpora`. The trust page will show **only the core
corpus** until the change below is made, because it renders `metrics` and
`corpus` and knows nothing about `corpora`.

Nothing is broken in the meantime, and that is deliberate: `metrics` and
`corpus` still mean exactly what they meant in 1.1, the core corpus alone, so
every trend line on the page keeps its history and no published number moves
because a new corpus was added. The page is **silently incomplete**, which is
the condition this item exists to end.

The stakes are higher than for follow-up 2. A reader who sees one extraction
precision figure will assume it describes the documents they are about to
upload. It describes notes and emails. The vertical numbers are **lower**, and
publishing only the higher ones while holding the lower ones in the artifact
would be the one thing this project must not do.

### What to change, precisely

Repository `Cogeto/cogeto-web`.

**1. `lib/trust.ts`, a new optional `corpora` field on the configuration type.**

```ts
export type CorpusResult = {
  id: string;                    // "core" | "vertical"
  label: string;                 // render as the corpus name
  description: string;           // render as the corpus explainer, verbatim
  extraction_cases: number;
  reconcile_pairs: number;
  per_language: LanguageMetrics[];
  aggregate: AggregateMetrics;
};
// on Configuration:
corpora?: CorpusResult[];
```

Treat it as optional in every validator. Releases up to and including the last
`1.1` file do not carry it, and dropping them would lose the history.

**2. A corpus selector beside the existing language filter.** Default to
**`core`**, so the page keeps showing what it shows today for a reader who does
not change anything, and make the selector visible rather than buried: the
whole point is that a reader can find the document numbers without knowing they
exist. When a release predates `corpora`, disable the selector and label it
"one corpus measured in this release" rather than hiding it, so the reader can
see when the distinction began.

**3. Render `description` verbatim under the corpus name.** It is written to be
read by a buyer and it is the sentence that explains why the vertical numbers
are lower. Do not summarise it.

**4. Gate floors per corpus.** `gates.json` gained a `vertical` block with its
own `gates` and `per_language` floors. `fetchGates()` currently returns one flat
set. When the corpus selector is on `vertical`, draw **that corpus's** floors,
and when the language filter is also set, that corpus's per-language floors.
Drawing the core floors against vertical measurements would show a failing build
that is not failing.

Note that the vertical block has **no `rewrite_accuracy`**. The query-rewrite
suite is a corpus of chat turns, not of documents, and there is no vertical arm
of it. Render a dash, not a zero.

**5. The `xl` set.** The vertical corpus reports a third set beside `en` and
`hr`: `xl`, the cross-language pairs, English against Croatian on one act. It
has reconciliation pairs and **no extraction cases**, so its extraction figures
are the harness's empty-arm convention (1.0) and must render as a dash rather
than as a perfect score. Label it "cross-language" in the language filter, not
as a language.

**6. Copy, next to the corpus selector.**

> These numbers are measured on two different corpora and we publish both. The
> first is the set the engine was built against: notes, emails, fetched pages
> and short excerpts. The second is real public documents of the kind you would
> upload: regulations, standards, device datasheets, tender specifications and
> one scanned publication from 1987. The document numbers are lower. That is
> what documents cost, and hiding it would make the other number useless to you.

Link "real public documents" to
`https://github.com/Cogeto/cogeto/blob/main/project/eval/vertical/README.md`,
which lists every document with its publisher, licence and retrieval date.

### Verification once done

1. Every release from `v0.8.0` onward still appears; the pre-1.2 files render
   with the corpus selector disabled rather than being dropped.
2. Switching the corpus selector to `vertical` changes every metric, the case
   counts, and the gate lines together.
3. The `xl` set shows dashes for the three extraction metrics, not 100 percent.
4. The corpus description renders in full.
5. House style: no em or en dashes in any of the copy above.
