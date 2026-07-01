# Cogeto — Evaluation Golden Set Specification

*Governs the eval harness (Addendum §B.4). The harness is built alongside the extractor (§A.11), not after it. Its published output is the trust score. This spec defines the corpus format, labeling rules, metrics, and CI gates; the harness implementation follows it.*

## 1. Purpose

Extraction quality is the product. The golden set is the hand-labeled corpus that measures whether Cogeto extracts the right facts, verifies them honestly, deduplicates correctly, and detects contradictions. Every prompt, model, or pipeline change is judged against it; regressions fail the build. The same numbers, per release, are the public trust score.

## 2. Corpus

- **Size:** 50 to 100 labeled items per supported language at launch (start: English + Croatian; add languages as connectors ship to those markets). Grow by adding every interesting real-world failure as a new case (anonymized or synthetic reconstruction, never real user data).
- **Item types**, proportioned to expected real traffic: notes and quick captures (~40%), emails (~35%), calendar events (~15%), document excerpts (~10%).
- **Difficulty mix:** each language set includes deliberately hard cases: conditional commitments ("send it after Luka confirms budget"), relative dates ("next Friday"), multi-fact sources, contradicting pairs, near-duplicate pairs, facts that supersede earlier facts, sources containing zero durable facts (the extractor must extract nothing), and sensitive-content cases.
- **Storage:** `project/eval/golden/{lang}/{case-id}/` with `source.txt` (or `.json` for structured items like events), `expected.json`, and optional `notes.md` explaining why the case exists. All fictional. Tracked in git; the corpus is part of the open repo, which is itself a trust artifact.

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
- **Dedup accuracy** = near-duplicate pairs correctly merged / all such pairs (false merges count double, because a wrong merge destroys a distinct fact).
- **Contradiction detection precision and recall** over the labeled contradiction pairs.
- All reported per language and aggregate.

## 6. CI gates (initial thresholds; ratchet up, never down, via decision record)

| Metric | Launch gate |
|---|---|
| Extraction precision | ≥ 0.85 |
| Extraction recall | ≥ 0.80 |
| Verification agreement | ≥ 0.90 |
| Dedup accuracy | ≥ 0.90 |
| Contradiction recall | ≥ 0.70 |

- Any prompt, model-version, or pipeline change that drops a metric below its gate fails the build.
- A change that drops any metric by more than 2 points from the previous release requires a decision record even if still above the gate.
- Gate values live in one versioned config file next to the corpus, so the published trust score and the CI gate can never disagree about what was measured.

## 7. Publication

Each release publishes: the metric table, the corpus size per language, the harness and threshold versions, and one sentence per notable change ("added 6 Croatian conditional-commitment cases after a design-partner miss"). This page is the trust score (Addendum §B.4). Honest numbers only; a dip that ships with an explanation is on-brand, a hidden dip is not.
