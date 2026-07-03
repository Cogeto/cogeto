# en-0002 — designed overreach: an amount discussed is not an amount decided

This note is bait. It contains every ingredient of a valuable-looking fact — a named
person, a company, a quarter, a euro amount, positive sentiment — and states **no
decision**. The €48,000 figure "came up"; nobody agreed to anything.

Why it exists (S2-A §5): the plausible-but-unsupported extraction this note invites is

> "Novira agreed to a €48,000 Q3 renewal." (kind: decision)

That claim is exactly what an over-eager extractor produces from co-occurrence
(amount + renewal + upbeat tone). Two independent defenses must catch it:

1. **The extractor should abstain from the decision**: the extraction prompt's
   no-inference rule ("a number being mentioned is not an agreed amount") means the
   durable facts here are a discussion fact and, at most, an open loop for next week.
2. **If the extractor overreaches anyway, the verifier must not let it become
   `active`**: no passage supports "agreed", so the verdict is `unsupported` (or
   `partial` at best) and the admission rule (§B.3) stores the memory as
   `uncertain`, flagged for review — never as trusted truth.

`verification_expected: unsupported` refers to that overreach candidate: the case
tests the safety net, not the happy path.

Owner hand-check: capture this text on the Memories page. Legitimate outcome: one or
two memories about a discussion/open loop, `active`. If anything claims a decision or
an agreed €48,000, it must wear the amber `uncertain` chip — that chip appearing is
the feature working, not a bug.
