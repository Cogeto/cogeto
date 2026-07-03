# en-0015-ana-teams-hedged (F7)

The source states the preference tentatively ("might prefer Teams … wasn't sure yet").

**Two dimensions, split in v0002 (decision 0007 / S3.5-B):**

- **Verification** judges SUPPORT ONLY. The claim faithfully carries the hedge, so
  the passage supports it exactly → `verification_expected: supported`. (At the
  S3.5-A baseline this was labeled `partial`, which encoded the F7 conflation of
  hedging with weak support; v0002 verification no longer downgrades for tentative
  wording, so the correct label is `supported`.)
- **Hedging** is the extractor's dimension: extraction v0002 sets `hedged: true`
  with the hedge phrase, and the admission rule makes the memory **uncertain**
  regardless of the (supported) verdict.

Net: the memory is `uncertain` (correct) while verification agrees at `supported`
(correct). The hedge → uncertain behavior is exercised end-to-end by the chat
eval's `hedge_marked` check (the answer marks it possibly/unconfirmed).
