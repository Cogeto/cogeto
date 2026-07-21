# 0035 — Deterministic sampling: temperature 0 for extraction and evals

Date: 2026-07-21. Status: accepted.

## Context

No model call in the system set a sampling temperature — extraction,
verification, chat answering, and the eval coverage grader all ran at the
provider default (~0.7). Measured consequence on identical configuration:
extraction precision swung ±1.6pt and verification agreement ±3.2pt between
runs, and the chat coverage judgment on single cases swung between 0% and
100% across four same-config runs. The live eval gate turned this
nondeterminism into recurring red mains.

## Decision

1. **Structured extraction is always `temperature: 0`** (the gateway's
   `extractStructured`, all callers, production included). What Cogeto
   remembers must not depend on a sampling dice roll; JSON-schema extraction
   has no use for creative variance.
2. **The eval harness pins `temperature: 0` on all its calls** (answering and
   grading included) via a new gateway/factory option, so runs measure the
   system, not the sampler.
3. **Production chat answering keeps the provider default** — conversational
   quality may legitimately benefit from sampling; changing that is a product
   decision this record does not make.

## Consequences

- Eval runs become comparable run-to-run; remaining variance reflects
  provider-side nondeterminism only (greatly reduced, not zero).
- Historical eval numbers (docs/eval/history.md before this date) were
  measured under default sampling — bands quoted from them overstate the
  variance of the post-0035 harness.
- The golden-set gate floors in gates.json stay unchanged (ratchet policy):
  re-measure bands under temperature 0 before raising anything.
