# Natural conversation (Priority 6)

**Decision [0046](../decisions/0046-conversational-routing-and-provenance.md) ·
prompts `query_rewrite/v0004` + `answer/v0005` · no migration · issues
#203/#204/#205.**

The user talks to Cogeto the way they would to any capable assistant; it
draws on memory, on the web when asked, and on the model's own knowledge —
and every claim visibly carries its origin. Never a private ChatGPT: the
differentiator is that Cogeto tells you, sentence by sentence, what it can
prove.

## The router (one surface, all capabilities)

Order inside `ChatService.ask` (decision 0046 ruling 1):

1. Deterministic guards: the small-talk lexicon (whole-turn "thanks!" /
   "hvala!" — deterministic natural reply, no retrieval, no model call), the
   create-task intent, the research imperative. All unchanged mechanisms,
   extended by the lexicon.
2. One bounded pipeline-tier call — the rewriter, now also the classifier
   (`question_class: personal | knowledge | smalltalk`), on every remaining
   turn. Retrieval reuses the result; routing + retrieval cost exactly one
   pipeline call per turn. Failure/timeout → the memory-question path.
3. Routes: model-classified small talk / meta → a natural answer-tier reply
   (`smalltalk` mode, recent turns for tone); the reply intent (the router's
   resolved entities let "draft a reply to her last email" reach Ana);
   otherwise retrieval for both personal AND knowledge questions
   (memory-first).

## Per-claim provenance

- Memory claims: `{{cite:uuid}}` chips, as always. Web-sourced memories'
  chips render the teal web treatment with URL + fetch time (the Priority 5
  web-source read).
- Model knowledge: the model marks each such statement `[U]` →
  canonical `{{unsourced}}` → the calm "unsourced" chip ("Model knowledge —
  not from your sources"). Permitted only when the input carries
  `GENERAL KNOWLEDGE: allowed` (knowledge-class questions); honored (never
  stripped into an unmarked claim) in every mode.
- The strip-unmapped-tokens guarantee extends: `scanAnswer` accepts exactly
  the two canonical tokens; malformed markers never leak; an unsourced
  segment has no id and can never render as a source.
- Frozen honesty: memory beats model knowledge and the answer says so;
  unsure means saying so; "nothing on record" stays for pure memory
  questions.

## Research stays gated

A knowledge question never silently searches. The answer arrives marked
unsourced with a one-tap OFFER (`researchOffer` on the done event, ephemeral)
that only PROPOSES a run and lands on the Research page — the existing
show-edit-approve gate, unchanged. Chat still cannot approve anything.

## Bounds

History window: 6 recent turns (`REWRITE_HISTORY_TURNS`) for the
rewriter/classifier and small-talk tone. Budgets: the per-user daily
decorator covers the whole surface. Streaming unchanged.

## Tests

`routing_matrix` + `smalltalk_lexicon` (`retrieval/chat-routing.spec.ts`);
`smalltalk_natural`, `research_never_silent`, memory-first fallback, blended
origins, both cross-capability follow-ups
(`retrieval/chat/chat-conversation.integration.spec.ts`);
`claim_origins_rendered`, `unsourced_never_cited`
(`retrieval/chat/citations.spec.ts`). Live chat-eval conversation cases (en +
hr) with the folded `conversation` rule-gate verdict: `knowledge_offer_en`,
`knowledge_offer_hr`, `blended_origins_en`, `memory_beats_model`,
`smalltalk_thanks`, `smalltalk_hvala_hr`, `followup_cross_capability`.

## Gotchas

- The reply-target normalization order matters: pronoun targets ("her") must
  null out BEFORE the rewriter-entity fallback fills in, or the resolved
  referent can never win.
- `resolveQuestionClass` is the same enable-and-veto posture as
  temporal/open-loops: never honor a smalltalk claim on a turn with entity
  candidates, never honor knowledge/smalltalk over a resolved intent.
- The live "Thinking…" indicator switches to "Answering from your memories…"
  only once sources arrive — small talk must not claim a search happened.
