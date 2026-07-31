# The gate model

*Decision record. Owner: Ivan Golubic. Written 2026-07-31, V2.0 item 3.4. This is
the single place every number in [`project/eval/gates.json`](../../project/eval/gates.json)
is justified. The config file carries the values and points here.*

## The governing rule

**Publish every measured metric including the unflattering ones. Gate at the
honest current floor. Ratchet up only, never down. Never set a gate the project
is currently failing, because a permanently red gate is not a gate: it teaches
people to bypass it.**

Where a metric sits below its specification target, the gap is published, the
floor is set at today's honest value, and the table below states the target, the
current value, and the planned work that closes it. Nothing is hidden because it
is uncomfortable, and nothing is aspirational because it would look better.

## How a floor is computed

**Floor = the lowest value observed across the measured runs at this exact
prompt, corpus and model configuration, rounded down to two decimals.**

Three properties matter, and all three are consequences of that one sentence:

1. **It is a value the project actually achieves.** The build is green today and
   stays green on an ordinary run.
2. **It is not the flattering value.** A good draw does not become the floor;
   the worst observed draw does.
3. **It is outside the noise band, not inside it.** A gate inside a metric's
   run-to-run band is a coin flip, and a coin-flip gate gets bypassed, which is
   worse than no gate. Every floor here is at or below the minimum of the
   observed band, so honest variance passes and a broken prompt (the historical
   degraded drill measured 8.8% precision) lands nowhere near it.

The rounding is a convention, not slack: it avoids a float-equality knife edge
where the floor and a measurement differ in the fifteenth decimal. It rounds the
TRUE fraction, never the displayed percentage: 54 of 73 prints as 74.0% and
floors to 0.73, and getting that backwards produces a gate that fails on the
very run it was calibrated from.

**The band is eight live runs on 2026-07-31**, all at `temperature: 0`, all on
this corpus. That matters more than it sounds. The reconciliation arm had
produced identical numbers on every release run since 2026-07-25, which reads
like determinism; running it eight times back to back shows it is not. Croatian
contradiction recall came back 100% six times and 66.7% twice. English
supersession accuracy ranged 25% to 75%. **The arm is not deterministic at
`temperature: 0`; it only looked deterministic because it was measured once per
release.** Several floors below are low because of that, and they are low
honestly rather than optimistically.

## Two layers

- **`gates`**: the aggregate floors.
- **`per_language`**: floors for every language the harness reports.

Aggregates mask. Croatian dedup accuracy sat at 0.833 under a 0.90 aggregate
gate for eight releases and nothing ever failed, because nothing ever looked.
A language the harness measures and `gates.json` does not name now **fails** the
gate check: an ungated language is precisely the hole these floors close.

The zero-tolerance gates (`injection_violations`, `subject_mismatches`) are
hardcoded in the harness rather than configured here, because they are not
thresholds. There is no acceptable rate at which a model may obey text inside
the untrusted-data fence.

## The floors

Specification targets are from `docs/eval-golden-set.md` §6 and spec §14.
Measured on `mistral-default` (mistral-small-latest / mistral-medium-latest /
mistral-embed) at `temperature: 0`, prompts `extraction/v0004` +
`verification/v0006` + `reconcile_dedup/v0001` + `reconcile_contradiction/v0001`
+ `query_rewrite/v0006`, 86 golden cases, 29 reconciliation pairs, 32
query-rewrite cases.

"Observed" is the range across the eight runs; the floor is its minimum, rounded
down. "Target" is the specification target where one exists.

### Aggregate

| Metric | Observed | **Floor** | Previous floor | Target | Gap to target |
|---|---|---|---|---|---|
| Extraction precision | 77.1 to 81.3 | **0.77** | 0.70 | 0.85 | **7 pts** |
| Extraction recall | 91.1 to 93.8 | **0.91** | 0.80 | 0.80 | clear |
| Verification agreement | 86.9 to 94.0 | **0.86** | 0.75 | 0.90 | **3 pts** |
| Dedup accuracy | 92.9 (flat) | **0.92** | 0.90 | 0.90 | clear |
| Contradiction precision | 54.5 to 66.7 | **0.54** | none (**never published**) | none set | see below |
| Contradiction recall | 83.3 to 100 | **0.83** | 0.70 | 0.70 | clear |
| Supersedes accuracy | 50.0 to 75.0 | **0.50** | none (**never gated**) | none set | see below |
| Query-rewrite routing | 90.6 (flat) | **0.90** | none (**never measured**) | none set | see below |

### English

| Metric | Observed | **Floor** | Target | Gap |
|---|---|---|---|---|
| Extraction precision | 79.7 to 83.1 | **0.79** | 0.85 | **5 pts** |
| Extraction recall | 92.9 to 94.6 | **0.92** | 0.80 | clear |
| Verification agreement | 92.7 to 100 | **0.92** | 0.90 | clear |
| Dedup accuracy | 100 (flat) | **1.00** | 0.90 | clear |
| Contradiction precision | 50.0 to 75.0 | **0.50** | none set | see below |
| Contradiction recall | 100 (flat) | **1.00** | 0.70 | clear |
| Supersedes accuracy | 25.0 to 75.0 | **0.25** | none set | see below |
| Query-rewrite routing | 100 (flat) | **1.00** | none set | clear |

### Croatian

| Metric | Observed | **Floor** | Target | Gap |
|---|---|---|---|---|
| Extraction precision | 74.0 to 80.6 | **0.73** | 0.85 | **11 pts** |
| Extraction recall | 87.5 to 92.9 | **0.87** | 0.80 | clear |
| Verification agreement | 81.4 to 90.7 | **0.81** | 0.90 | **9 pts** |
| Dedup accuracy | 83.3 (flat) | **0.83** | 0.90 | **7 pts** |
| Contradiction precision | 50.0 to 66.7 | **0.50** | none set | see below |
| Contradiction recall | 66.7 to 100 | **0.66** | 0.70 | **4 pts** |
| Supersedes accuracy | 60.0 to 75.0 | **0.60** | none set | see below |
| Query-rewrite routing | 81.3 (flat) | **0.81** | none set | see below |

**No floor was lowered.** Every aggregate floor is above the v1 value it
replaces: precision 0.70 to 0.77, recall 0.80 to 0.91, verification 0.75 to
0.86, dedup 0.90 to 0.92, contradiction recall 0.70 to 0.83. Three metrics are
gated for the first time.

## The gaps, and what closes them

### Extraction precision: 7 points aggregate, 12 in Croatian

The oldest gap and the most-worked. Its history is
[`v1-1-0-precision-drop.md`](v1-1-0-precision-drop.md): a large part of the
distance from 0.85 is that the corpus has been made deliberately harder five
times since the target was written, and precision is the metric that pays for
hard negatives. **Closed by:** V2.1 item 4.2 (anchoring, which reduces ambiguous
re-extraction) and V2.1 4.3 (the per-source extraction gate, which stops corpus
flooding). Croatian additionally needs corpus growth: 44 cases is the smallest
set that carries a floor here.

### Verification agreement: 3 points aggregate, 9 in Croatian

Much of the residual disagreement is the verifier **correctly** demoting a bad
extraction, so the metric conflates extractor quality with verifier calibration
and will not reach 0.90 by fixing the verifier alone. **Closed by:** the same
extraction work, plus splitting the metric so a correct demotion of a bad
extraction stops counting against the verifier. That split is not scheduled and
is named here so it is not forgotten.

### Contradiction precision: no target, and a floor of 0.50

**This is the number V2.0 item 3.4 exists to stop hiding.** It has been measured
since the reconciliation suite was built and was never emitted, so the published
picture was the flattering half of what the harness knew.

It is also **lower than the 0.857 the V2.0 plan quotes**, and the reason is the
corpus, not a regression: this pass added nine supersedes pairs, and a
supersession the judge reads as a plain contradiction lands as a precision miss.
The plan's 0.857 was measured on a corpus with **one** supersedes pair. Per the
rule from the v1.1.0 record, that consequence is stated rather than absorbed.

The floor is 0.50 because the denominator is tiny (4 to 5 flagged contradictions
per language) and the judgment is nondeterministic, so one flip moves the metric
20 to 25 points. **Closed by:** V2.3 contradiction coverage, which is where the
judge and the pair corpus both get the work. A target is set there, not here:
setting one now against a 5-pair denominator would be theatre.

### Supersedes accuracy: no target, and a floor of 0.25 in English

Before this pass the metric was **0 out of 1**, a rate over a single case, which
means nothing whether it passes or fails. It is now over 4 to 5 pairs per
language covering the ordinary shapes, and the honest answer is that supersession
detection is **weak and unstable**: English ranged 25% to 75% across six runs of
identical inputs.

`en-r008`, the pair that was failing before this pass, still fails. It was not
deleted and not weakened. **Closed by:** V2.3, which fixes the interval
arithmetic and the judge behind it. Growing the pair corpus further is what makes
the floor mean something; at 4 pairs, one case is 25 points.

### Query-rewrite routing: Croatian at 0.81, and two named defects

Gated for the first time. English is 16 of 16 on every run. Croatian is 13 of 16
on every run, and the three failures are the same three every time, which makes
them defects rather than noise:

1. **`hr-rw05` and `hr-rw06`: Croatian relative dates do not resolve.** The
   temporal lexicon recognises `u ožujku` and `od lipnja` and correctly routes
   the turn, but the date resolver is `chrono-node` in English only, so the
   expression resolves to nothing and the intent falls back to default
   retrieval. Croatian time travel by month name **does not work today**. It
   fails safe (a normal answer, not a wrong one), and it fails silently, which
   is why it survived until something measured it directly.
2. **`hr-rw10`: a Croatian possessive survives reply-target cleaning.** "Napiši
   odgovor na Aninu e-poruku" yields the target `Aninu` rather than `Ana`, so
   the resolver searches the mailbox for a sender that does not exist. The same
   family of bug as the `e-` phantom sender the live gate caught once before.

Both are **published, not fixed here**: this item is about measuring honestly,
and changing the rewriter's behaviour is a separate change with its own gate
run. They are the first entries for the Croatian half of V2.0 item 3.5 (i18n)
to answer.

### Still not gated at all (spec §14.4)

§14.4 requires **anchoring** and **ambiguity handling** to be measured and gated
too. Neither is, and this is the **first wave**. They are named here so the gap
is visible rather than implied by their absence.

## What is deliberately strict

Three floors sit at **1.00**: English dedup accuracy, English contradiction
recall, and English query-rewrite routing. Each produced an identical perfect
score on all eight runs, and English dedup and contradiction
recall have been perfect on every recorded release run for two months.

The consequence is deliberate and worth stating plainly: **a single-case
regression in any of them fails the build.** That is the ratchet working as
specified, and it is the direct answer to "a further regression fails the build
while the existing gap does not".

It is also the floor most likely to prove flaky, because query-rewrite routing
depends on a live model classification and eight runs is not a large sample. If it
does, the remedy is the documented one and not a quiet edit: measure it, write
what was measured in the pull request that changes the number, and change it
there. A floor moved with data is fine. A floor moved because it was annoying is
the thing this record exists to prevent.

The Croatian contradiction-recall floor of **0.66** is the opposite problem and
deserves the same plainness: with three contradiction pairs, one flip is 33
points, so no floor on that denominator can be both honest and meaningful. The
floor is honest. Making it meaningful is corpus growth, not arithmetic.

## Changing a number here

- **Raising a floor** is a config edit. Do it when a metric has cleared its
  floor on every measured run for a while; the ratchet exists to capture gains,
  and a floor that never moves is a floor nobody is measuring against.
- **Lowering a floor** is a deliberate act that must be justified in the pull
  request that does it, and it must say what was measured. There is no other
  route.
- **A corpus change that moves a headline metric** is justified the same way, in
  the pull request that makes it. Adding deliberately hard cases is good work
  and it lowers metrics: that is a reason to say so, not a reason to say
  nothing. The one time this was skipped is written up in
  [`v1-1-0-precision-drop.md`](v1-1-0-precision-drop.md).
- **Only live runs set floors.** The pull-request gate replays cached model
  responses, which measures the harness rather than the models; it can never
  publish a trust score and it must never be the source of a floor.
