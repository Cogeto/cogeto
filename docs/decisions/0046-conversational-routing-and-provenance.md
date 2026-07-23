# 0046 — Conversational routing and per-claim provenance (Priority 6)

Date: 2026-07-23. Status: accepted. Context: Post-v1 Backlog Priority 6
(natural conversation). Prompts: `query_rewrite/v0004`, `answer/v0005`.
No migration.

Cogeto's chat becomes a natural conversational surface: the user talks to it
as they would to any capable assistant, and it draws on memory, on the web
when asked, and on the model's own knowledge. It is never positioned or built
as a private ChatGPT — the differentiator, frozen here, is that every claim
visibly carries its origin: Cogeto tells you, sentence by sentence, what it
can prove.

## Ruling 1 — One router, frozen precedence, memory-first

Intent handling unifies into one router at the top of `ChatService.ask`, in
this order:

1. **Deterministic guards first** (unchanged in spirit, extended): the
   small-talk lexicon (whole-turn pleasantries, en + hr), the create-task
   intent (0038), the research imperative (0045), each purely deterministic.
2. **One bounded pipeline-tier call** — the existing rewriter, extended with a
   `question_class` field (`personal` | `knowledge` | `smalltalk`), now runs
   on EVERY remaining turn (`alwaysClassify`) because a self-contained
   knowledge question carries no lexical hint. It remains the router's ONLY
   added model call; retrieval reuses its result (`RetrieveOptions.rewrite`)
   instead of rewriting again.
3. **Routes from the classification**: model-classified small talk → a brief
   answer-tier reply; the reply-draft intent (deterministic hint, with the
   rewriter's resolved entities improving the target); otherwise retrieval —
   for BOTH personal and knowledge questions.

Frozen rules:

- **Memory-first.** When the question could be answered from memory, memory
  retrieval runs and grounds the answer; general model knowledge supplements,
  marked, and never replaces a grounded fact.
- **The veto guard** mirrors temporal/open-loops (0012/0013): a `smalltalk`
  claim on a turn naming an entity, and any `knowledge`/`smalltalk` claim on
  a turn that resolved a temporal, open-loops, or reply intent, are discarded.
  **Classification failure falls back to the memory-question path** —
  `personal` is both the default and the failure mode.
- **Research stays explicit** (0045 unchanged). A knowledge question the model
  cannot fully answer does NOT silently trigger research: the assistant
  answers what it can (marked unsourced) and OFFERS research as a one-tap
  suggestion (`researchOffer` on the done event, ephemeral, carrying the
  self-contained topic). Tapping the offer PROPOSES a run and lands on the
  Research page — the existing minimise-and-approve gate, unchanged. The
  offer is the bridge; the gate stays the gate. Every knowledge-class answer
  carries the offer when the research seam is wired.
- **Action intents keep ask-when-ambiguous** (0038/O4 behavior unchanged).
  Cross-capability anaphora resolves through the same router call: "draft a
  reply to her last email" reaches the resolver with the resolved person
  (pronoun targets normalize BEFORE the entity fallback), and "research her
  company" resolves the topic before proposing.
- **Small talk gets no retrieval theatre.** Lexicon-matched pleasantries
  answer deterministically (no model call); model-classified small talk and
  meta-questions about Cogeto answer naturally on the answer tier
  (`smalltalk` mode, recent turns for tone) — never "nothing on record" for
  "thanks!", never a citation.

## Ruling 2 — Per-claim provenance: the unsourced marker

The citation grammar (0007 ruling 2) gains a second canonical token:
`{{unsourced}}`. The model emits `[U]` after each statement from its own
knowledge (the same shape as `[F#]`; a terminal marker is robust where span
wrapping is fragile); the post-processor canonicalizes it. Blended answers
thus carry three origins, each visible: memory claims cite memories
(`{{cite:uuid}}`), web claims cite their web-source memories (whose chips
carry URL + fetch time via the Priority 5 web-source read), and model
knowledge is wrapped in the unsourced marker.

- The strict-grammar guarantee EXTENDS, never weakens: `scanAnswer` accepts
  exactly the two canonical tokens; everything else is stripped and counted.
  A malformed unsourced token never leaks. An unsourced segment carries no id
  and can never render as a source.
- `[U]` is honored in every mode (a model admitting a claim is its own
  knowledge is marked, never stripped into an unmarked claim), but the answer
  prompt permits it only under `GENERAL KNOWLEDGE: allowed` — a line the
  input carries only for knowledge-class questions.
- Honesty behaviours frozen in `answer/v0005`: the user's facts beat model
  knowledge, and the answer states the tension when they conflict; unsure
  means saying so rather than fabricating; "nothing on record" remains for
  pure memory questions, while a knowledge-class blend may follow the honest
  gap with clearly-marked general knowledge plus the research offer.
- The renderer treats unsourced spans with a calm, honest affordance (the
  `unsourced` chip: "Model knowledge — not from your sources"), deliberately
  distinct from every citation chip. The marking is a feature, not a warning.
- Per the prompt's contract, any unmarked claim-bearing sentence in a blended
  answer is defined as the model's failure — the renderer's job stays
  mechanical (canonical tokens only), never interpretive.

## Ruling 3 — Latency, cost, and history bounds

Routing adds at most the one bounded pipeline-tier call (4s timeout, fallback
to raw query + `personal`); blended and small-talk answers stay on the answer
tier; the per-user daily budget decorator covers the whole surface unchanged.
The conversation window stays `REWRITE_HISTORY_TURNS = 6` recent turns
(oldest first) — the rewriter's context AND the small-talk tone context; the
answer path still sees only the retrieved facts, never raw history, for
grounded modes. Streaming is unchanged (sources → token* → done; the offer
rides on done).

## Verification

`routing_matrix`, `smalltalk_lexicon` (chat-routing.spec);
`smalltalk_natural`, `research_never_silent`, memory-first fallback, blended
origins, cross-capability follow-ups (chat-conversation.integration.spec);
`claim_origins_rendered`, `unsourced_never_cited`, malformed-unsourced
(citations.spec). Live chat-eval: `knowledge_offer_en`/`_hr`,
`blended_origins_en`, `memory_beats_model`, `smalltalk_thanks`/`_hvala_hr`,
`followup_cross_capability` — the folded `conversation` verdict joins the
all-must-pass rule gate.
