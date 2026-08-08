# Cogeto: Evaluation Golden Set Specification

*Governs the eval harness (spec §14). The harness is built alongside the extractor, not after it. Its published output is the trust score. This spec defines the corpus format, labeling rules, metrics, and CI gates; the harness implementation follows it.*

## 1. Purpose

Extraction quality is the product. The golden set is the hand-labeled corpus that measures whether Cogeto extracts the right facts, verifies them honestly, deduplicates correctly, and detects contradictions. Every prompt, model, or pipeline change is judged against it; regressions fail the build. The same numbers, per release, are the public trust score.

## 2. Corpus

- **Size:** 50 to 100 labeled items per supported language at launch (start: English + Croatian; add languages as connectors ship to those markets). Grow by adding every interesting real-world failure as a new case (anonymized or synthetic reconstruction, never real user data).
- **Item types**, proportioned to expected real traffic: notes and quick captures (~45%), emails (~35%), document excerpts (~10%), fetched web pages (~10%).
- **Difficulty mix:** each language set includes deliberately hard cases: conditional commitments ("send it after Luka confirms budget"), relative dates ("next Friday"), multi-fact sources, contradicting pairs, near-duplicate pairs, facts that supersede earlier facts, sources containing zero durable facts (the extractor must extract nothing), and sensitive-content cases.
- **Storage:** `project/eval/golden/{lang}/{case-id}/` with `source.txt` (or `.json` for structured items like events), `expected.json`, and optional `notes.md` explaining why the case exists. All fictional. Tracked in git; the corpus is part of the open repo, which is itself a trust artifact.

### 2.1 The second corpus: the vertical set (V2.3 item 6.4)

Everything in §2 describes the **core** corpus (`project/eval/golden/`). Since
V2.3 item 6.4 a **second** corpus sits beside it,
[`project/eval/vertical/`](../project/eval/vertical/README.md), and the rules
below differ from §2 in exactly three ways:

1. **The items are real, not fictional.** §2 says "All fictional", which is
   right for notes and emails reconstructed from user traffic. The vertical set
   is built from real, publicly available documents, because model-written
   fixtures are cleaner and more internally consistent than real ones and a
   corpus of them flatters the system. Every document records its URL,
   publisher, licence, retrieval date and SHA-256 in `documents.json`, the
   original bytes are fetched rather than committed, and only material that may
   lawfully be redistributed is used.
2. **Item types are documents**: regulatory guidance, standards, device
   datasheets, public tender specifications and one scan, rather than the
   45/35/10/10 proportions in §2.
3. **It is scored, reported and gated SEPARATELY**, never averaged into the core
   numbers. A hard new corpus folded into a mature one hides both signals.

Everything else is identical: the same `expected.json` and `pair.json` formats,
the same harness, the same thresholds, the same metrics, the same zero-tolerance
gates. The labelling rules that only arise on real documents (what counts as a
fact worth extracting from a specification, what counts as a genuine
contradiction versus a legitimate difference of scope, condition or precision,
when two documents about different models must not be paired, how to treat a
statement hedged in the source) are written down before the first label in
[`project/eval/vertical/LABELLING.md`](../project/eval/vertical/LABELLING.md).

The corpus reports a third set beside `en` and `hr`: **`xl`**, the
cross-language pairs. It has reconciliation pairs and no extraction cases, and
it is gated like a language.

## 3. Label format (`expected.json`)

```json
{
 "case_id": "en-0042",
 "source_type": "email",
 "expected_memories": [
 {
 "content_gist": "Ana will send the revised proposal to Marko",
 "kind": "commitment",
 "entities": ["Ana", "Marko"],
 "subject_entity": "Ana",
 "condition": "after Marko confirms the budget",
 "temporal": { "valid_from": "source_date" },
 "must_extract": true
 }
 ],
 "must_not_extract": [
 "pleasantries, signatures, quoted earlier thread content"
 ],
 "expected_relations": [
 { "type": "supersedes", "target_case": "en-0038" }
 ],
 "verification_expected": "supported"
}
```

Matching between an extracted fact and an expected label is semantic, not string-equal: the harness uses embedding similarity plus entity overlap with a fixed threshold, and the threshold itself is versioned so scores stay comparable across releases.

`subject_entity` is optional and, when declared, is an exact assertion (case-insensitive), not a semantic one: the reconciliation candidate gate keys on exact subject equality, so a drifted subject silently disables contradiction and supersession detection while every similarity metric still passes. Declare it on cases designed to trap subject drift (the `*-s0NN` cases); a mismatch on any declaring case fails the zero-tolerance `subject_mismatches` gate.

## 4. Labeling rules

1. Label what a diligent human assistant would remember, nothing more. If a reasonable assistant would not note it, `must_extract` is false.
2. Every expected memory names its entities and kind (`commitment`, `decision`, `preference`, `fact`, `open_loop`).
3. Conditions and relative times are labeled explicitly; resolving them is part of what is being tested.
4. Contradiction and supersession pairs always reference the other case id, so reconciliation is testable deterministically.
5. Two-person rule once the team grows: a second reviewer signs off on every label change. Until then, label changes get one line in `project/eval/golden/CHANGELOG.md`.

## 5. Metrics

- **Extraction precision** = extracted facts matching an expected label / all extracted facts.
- **Extraction recall** = expected `must_extract` labels matched / all such labels.
- **Verification agreement** = verifier verdicts matching `verification_expected` / all cases.
  `supported` and `partial` are scored over the facts that MATCHED an expected label, so
  **a case with no expected memories may not declare them**: with nothing able to match, the
  case would be counted as disagreeing on every run forever, whatever the system did. A case
  that must remember nothing declares the trap rule (`unsupported`: no stray fact was admitted
  supported and unhedged) or omits the field, which means "this case does not measure
  verification". The harness enforces this when the corpus loads and fails the run loudly;
  three Croatian cases sat in the unreachable state long enough to hold that language's floor
  one case away from red.
- **Dedup accuracy** = near-duplicate pairs correctly merged / all such pairs (false merges count double, because a wrong merge destroys a distinct fact).
- **Contradiction detection precision and recall** over the labeled contradiction pairs.
- **Supersedes accuracy** = correct supersession decisions (verdict **and** direction) / the pairs where supersession was at stake, which is the labelled `supersedes_*` pairs **plus** any pair the system superseded that should not have been. False positives sit in the denominator on purpose: a wrong supersession closes the validity interval on a fact that still holds, which is the same class of harm as a false merge, and scoring only the labelled pairs made it invisible.
- **Query-rewrite routing accuracy** (§5.1) = routing cases where every assertion held / all such cases.
- All reported per language and aggregate, **and since V2.3 item 6.4 per corpus**: the core set and the vertical document set are reported side by side and never averaged. **All published**, including the unflattering ones (§7).

### 5.1 The query-rewrite suite

The rewrite layer decides intent routing, pronoun resolution and temporal classification on every chat turn, and was measured only indirectly until V2.0 item 3.4: a downstream answer assertion fails for many reasons, and a mis-route surfaces as "the answer was wrong" rather than "this went to the wrong place".

Cases live in `project/eval/rewrite/{lang}/{case-id}.json` and run the real decision path in the router's own order: the deterministic detectors (small talk, skill brief, research) first, and the model call only on turns none of them claimed, exactly as `ChatService` does.

A case asserts the full intent shape, and **an expectation omitted from the file means "must be null"**. A case authored for pronoun resolution therefore carries negative coverage for every intent it is not, which is how the suite proves the veto guards hold rather than only that the positive path fires. `question_class` is required except on turns a deterministic detector pre-empts, where the router never reads it.

Each case passes only if every one of its assertions holds. The corpus covers, per language: a plain question with no special intent, pronoun resolution across turns, ellipsis, the three temporal kinds including the relative-date forms, a temporal negative, unscoped and entity-scoped open loops, a named and a demonstrative reply target, a research trigger and a research negative, the brief skill, a knowledge question, and small talk.

## 6. CI gates

Gates are enforced when the gate environment switch is set (`npm run eval:gate`, CI). Values live in one versioned config next to the corpus (`project/eval/gates.json`), so the published trust score and the CI gate can never disagree about what was measured.

Two layers since V2.0 item 3.4, and two corpora since V2.3 item 6.4:

- **`gates`**: the aggregate floors for the core corpus.
- **`per_language`**: floors for every language the harness reports, so a weak language can no longer hide inside a healthy average. A language the harness measures and `gates.json` does not name **fails** the check; an ungated language is the hole these floors close.
- **`vertical.gates`** and **`vertical.per_language`**: the same two layers for the vertical document corpus, with the same union rule (a set it measures and this file does not name fails). It carries no `rewrite_accuracy` floor, because the query-rewrite suite is a corpus of chat turns rather than of documents and gating a metric a corpus cannot measure would gate the harness's empty-arm convention rather than the system. Its floors are **lower** than the core ones, which is the expected and published result rather than a regression.

The zero-tolerance gates are hardcoded in the harness rather than thresholded in `gates.json`, because they are not thresholds:

| Gate | Value | Why |
|---|---|---|
| Injection violations | **0** | Audit 2.0 SEC-4: a violation means a model obeyed text inside the untrusted-data fence. There is no acceptable rate. |
| Subject mismatches | **0** | Issue #313, counted only on cases that declare `subject_entity`: a drifted subject silently disables reconciliation while every similarity metric still passes. |

**Every numeric floor, its specification target, the gap where there is one, and the work that closes it: [`eval/gate-model.md`](eval/gate-model.md).** That record is the single place the gate numbers are justified; `gates.json` carries the values and points at it.

The governing rule, in one line: **publish every measured metric including the unflattering ones, gate at the honest current floor, ratchet up only, and never set a gate the project is currently failing** because a permanently red gate is not a gate, it teaches people to bypass it.

**The ratchet rule: gates only move up.** Raising a gate is a config edit. Lowering one is a deliberate act that must be justified in the pull request that does it, and it must say what was measured. A drop of more than 2 points from the previous release needs the same justification even when the metric is still above its gate. The one time that rule was breached and no record was written, the record was written late: [`eval/v1-1-0-precision-drop.md`](eval/v1-1-0-precision-drop.md).

**A corpus change that moves a headline metric is justified the same way**, in the pull request that makes it. Adding deliberately hard cases is good work and it lowers metrics; that is a reason to say so, not a reason to say nothing.

### The chat gate

Each signal is gated by its reliability. The **deterministic rule checks** (entity, hedge, no-mechanics, citations, nothing-on-record, temporal framing, language, skill, ambiguity branch) remain all-must-pass across all cases. The **LLM-judged coverage** number gates on the **mean** across coverage-graded cases, under the same ratchet policy, because coverage on a single case measurably swings under identical configuration and a per-case gate turned judge noise into failed builds. Per-case pass and fail is still computed, printed, and published unchanged; only the CI verdict arithmetic differs. There are no retries.

A single noisy coverage judgment can therefore no longer fail the build, while a real regression still fails hard: it trips the rule checks and collapses the mean across cases at once.

### Determinism

Structured extraction always runs at `temperature: 0` in production, and the harness pins temperature 0 on **all** its calls, answering and grading included, so runs measure the system rather than the sampler. Numbers measured before that pinning came from default sampling, so any variance band quoted from older history overstates the current harness. Re-measure bands under temperature 0 before raising any gate.

### Cached evaluation on pull requests

Pull requests used to run the harness's **build** only, so a prompt change that wrecked extraction merged green and the live gate found it afterwards, on `main`. Since V2.0 item 3.4 the golden-set suite (extraction, verification, reconciliation and query-rewrite routing) runs on every pull request against **committed fixtures** recorded from a live run:

```sh
npm run eval:cached          # replay the golden-set suite, gated (what CI runs on a PR)
npm run eval:cache:refresh   # re-record the fixtures against the live models
```

**What a cached run proves.** It catches prompt regressions, pipeline and routing regressions, scoring and harness regressions, and corpus mistakes: anything where the same model response should have produced a different score.

**What it does not prove.** It does not catch model-side drift. `mistral-small-latest` is a moving target and the fixtures freeze one day's behaviour. **The live post-merge run remains the authority for the published numbers, and only live runs feed the trust artifacts**: `--emit-json` refuses to run in replay mode, so a cached run can never become a published trust score. The job says all of this in its own output, not only here.

**The key, and why a prompt change cannot hit it.** Every entry is keyed by a SHA-256 over the harness scoring version, the operation, the requested tier and the model that tier resolves to, the **system prompt verbatim**, and the **full rendered input verbatim, fences and all**. The system prompt *is* the rendered prompt artifact, so a version bump and an uncommitted local edit both miss by construction rather than by anyone remembering to bump a number. Embeddings are keyed **per text**, not per batch, so a differently sized batch of the same strings still hits: batch composition is a caller detail and must not be able to invalidate a cache.

**Exactly three things are normalised**, and each one is **ambient**: it changes on every run whatever the code does, so leaving it in the key would mean a cache that never hits, which is no gate at all.

1. **UUIDs**, which a fresh Testcontainers database mints anew every run.
2. **The untrusted-data fence's per-call boundary id** (audit 2.0 SEC-4 mints 18 fresh hex characters on every model call). Matched only inside its marker line, so the fence's presence and position still hash: removing a fence, or moving text out of one, still misses.
3. **The now-block's wall clock**, stamped from the system clock on every chat turn. The instant is masked; the timezone and every other line of the block are not, so a change to the block's format, the language rule or the user context still misses.

Nothing else is normalised. All three carve-outs are asserted in the unit suite, alongside the assertions that a prompt edit, a model change, a tier change and a one-character input change each miss.

**The limitation this creates, stated rather than buried.** A cached run reproduces the wall-clock context of the recording. An assertion that depends on today's date relative to a case anchor (a commitment being overdue rather than upcoming, say) is therefore verified by the **live** post-merge run, not by the cached one. The cases are authored so their assertions hold for any present after their anchor, which is why this is a limitation and not a bug, but it is a real edge the cached gate does not cover.

**A miss fails the job.** It is not skipped and not counted as a pass; the error names `npm run eval:cache:refresh`. A partial run reported as green is the false green this whole mechanism exists to prevent.

**Where it lives.** `project/eval/cache/`, committed, about 2 MB. Fixtures were chosen over a CI cache because a CI cache can be cold or evicted, which turns a required check into a coin flip, and because a committed fixture is reviewable: `responses.json` is pretty-printed and shows exactly what the models said, so a refresh diff is readable. Embedding vectors go in `embeddings.jsonl` as exact base64 float32 rather than rounded decimals, because a rounded vector could flip a borderline similarity match and make the cached run measure something the live run does not.

**A refresh starts from an empty directory** (`rm -rf` is part of the command), so the committed fixtures are always exactly one recording, with no orphans left by an earlier one. That is what makes a refresh diff mean something.

**If a refresh captures a live flake**, re-record, exactly as you would re-run a flaky live gate: a recording that happens to freeze a rare bad draw is unrepresentative, and a permanently red cached gate teaches people to bypass it. What must never happen is re-recording repeatedly until the numbers look good. **If the same case fails on a second recording, it is not a flake**: treat it as a regression and find out why.

**Fork pull requests** hold no secrets and run the cached path only, which is exactly what they should do.

#### The chat suite is NOT cached, and why

It was attempted and it does not work, for a reason worth writing down rather than retrying.

The answer prompt embeds the retrieved facts, in retrieval order, as `[F1]…[Fn]` blocks. **Equally scored facts come back in a different order on each run.** With every model response served from the cache and every embedding bit-identical, the same case still built a different prompt:

```
-[F1] Ana wants Marta included in the import mapping review for Atlas.
+[F1] Ana confirmed the Atlas CRM Migration will run in two waves: sales first, then support.
+[F2] Ana wants Marta included in the import mapping review for Atlas.
```

Same facts, shuffled. A different prompt is a different key, so the cache misses on the first answer of the first case, every time.

Normalising fact order out of the key would be **wrong**: order genuinely changes the answer, and masking it would hide exactly the kind of regression this gate exists to catch. The honest fix is upstream, a **stable tiebreak on equally scored facts in retrieval fusion**, keyed on something content-derived rather than on a per-run row id. That is a retrieval behaviour change with its own gate run, so it is a named follow-up rather than something smuggled in here.

Until then the chat suite runs **live, post-merge**, exactly as it did before.

### When the live gates run

The **live** gates run on pushes to `main`, and only when the pushed range touches quality-relevant paths (prompts, eval data, the model gateway, ingestion, retrieval, memory, the eval entrypoints). Anything else **skips loudly** with a warning annotation, never silently. Release runs always measure live. Pull requests run the **cached** gates above; no secret is read on a pull-request branch at all.

## 7. Publication

Each release publishes: the metric table, the corpus size per language, the harness and threshold versions, and one sentence per notable change ("added 6 Croatian conditional-commitment cases after a design-partner miss"). This page is the trust score (spec §14). Honest numbers only; a dip that ships with an explanation is on-brand, a hidden dip is not.

**Published means all of them.** From schema 1.1 (V2.0 item 3.4) the artifact carries contradiction **precision**, **supersedes accuracy** with its denominator, and **query-rewrite routing accuracy**, per language and aggregate, beside the metrics that were already there. Contradiction precision had been measured since the reconciliation suite existed and was simply never emitted, which made the published picture the flattering half of what the harness knew. Supersedes accuracy is published with its denominator because a rate over one case means nothing whether it passes or fails.
