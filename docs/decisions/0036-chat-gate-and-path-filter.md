# 0036 — Chat gate arithmetic and path-filtered live evals

Date: 2026-07-21. Status: accepted. Revises decision 0011's chat gate rule.

## Context

The chat eval gated on "all 12 cases must PASS, single attempt", where a
case's verdict mixes deterministic rule checks (entity, hedge, no-mechanics,
citations, nothing-on-record, temporal framing) with one LLM-judged number
(coverage). Coverage on single cases measurably swings under identical
configuration, so the gate turned judge noise into failed builds. Separately,
the live gates ran on every push to main — including dependency bumps and
docs changes that cannot affect answer quality — burning live model calls
and producing irrelevant red mains (the 2026-07 dependency wave).

## Decision

1. **Gate each signal by its reliability.** The deterministic rule checks
   remain all-must-pass across all cases. The LLM-judged coverage gates on
   the MEAN across coverage-graded cases against `chat_gates.mean_coverage`
   in gates.json (same ratchet-up-only policy as every gate). Per-case
   pass/fail is still computed, printed, and published in the trust scores
   unchanged — only the CI verdict arithmetic changed. No retries: the rule
   change costs zero additional model calls.
2. **Path-filtered live gates.** On push to main, the live golden-set and
   chat gates run only when the pushed range touches quality-relevant paths:
   `project/prompts/`, `project/eval/`, `project/src/model-gateway/`,
   `project/src/ingestion/`, `project/src/retrieval/`, the eval entrypoints,
   or `project/src/tasks/`. Anything else skips LOUDLY (warning annotation),
   the same pattern as the missing-secret skip. Release trust-scores runs are
   unaffected — a release always measures live.
3. Initial `chat_gates.mean_coverage` is calibrated from the first
   temperature-0 baseline run with margin, recorded in gates.json's note.

## Consequences

- A single noisy coverage judgment can no longer fail the build; a real
  regression (broken prompt/pipeline) still fails hard — it trips the rule
  checks and collapses the mean across cases at once.
- Live eval spend drops to near zero outside model/prompt/pipeline work.
- Pushes that skip the live gate are visible as annotations, never silent.
