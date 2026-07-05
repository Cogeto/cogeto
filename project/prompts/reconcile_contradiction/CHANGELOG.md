# reconcile_contradiction — changelog

- **v0001** (2026-07-05, F2-A): initial contradiction confirmation prompt (decision
  0010). Verdict contradicts | compatible | supersedes(direction) with a
  one-sentence reason. Explicit cost table: a wrong contradiction wastes the user's
  attention → hesitation between contradicts and compatible resolves to compatible;
  supersedes requires an explicit update relationship (newer value for the same
  slot), never mere difference, and loses every doubt (to contradicts against
  contradicts-doubt, to compatible against compatible-doubt). Three embedded
  contrast examples: same-slot conflict, same-topic/different-aspect compatible
  trap, and an explicit "moved to" supersession. Baseline scored by the
  reconciliation pair cases in the same session (docs/eval/history.md).
