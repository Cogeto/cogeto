# Conversation: routing, provenance, context, and threads

Cogeto's chat is a natural conversational surface: you talk to it as you would to
any capable assistant, and it draws on your memory, on the web when you ask, and on
the model's own knowledge. It is never positioned or built as a private ChatGPT.
**The differentiator is that every claim visibly carries its origin.** Cogeto tells
you, sentence by sentence, what it can prove.

## One router

Intent handling is one router at the top of `ChatService.ask`, in this order:

1. **Deterministic guards first.** The small-talk lexicon (whole-turn pleasantries,
   en + hr), the skill-brief intent, and the research imperative. All purely
   deterministic, no model call.
2. **One bounded pipeline-tier call.** The query rewriter, which resolves pronouns
   and follow-ups against recent turns and also returns a `question_class`
   (`personal` | `knowledge` | `smalltalk`). It runs on **every** remaining turn,
   because a self-contained knowledge question carries no lexical hint. This is the
   router's only added model call, and retrieval reuses its result rather than
   rewriting again. Four-second timeout, falling back to the raw query.
3. **Routes from the classification.**

### Frozen rules

- **Memory-first.** When a question could be answered from memory, retrieval runs
  and grounds the answer. General model knowledge supplements it, marked, and never
  replaces a grounded fact.
- **The veto guard.** A `smalltalk` claim on a turn that names an entity, and any
  `knowledge` or `smalltalk` claim on a turn that resolved a temporal, open-loops,
  or reply intent, are discarded. **Classification failure falls back to the memory
  path**: `personal` is both the default and the failure mode.
- **Research stays explicit.** A knowledge question the model cannot fully answer
  never silently triggers a search. The assistant answers what it can, marked
  unsourced, and *offers* research as a one-tap suggestion. The offer is the bridge;
  the gate stays the gate. See [`web-research.md`](web-research.md).
- **Small talk gets no retrieval theatre.** Lexicon-matched pleasantries answer
  deterministically. Model-classified small talk and meta-questions about Cogeto
  answer naturally on the answer tier. Never "nothing on record" for "thanks", never
  a citation.
- **Action intents ask when ambiguous.**

The conversation window is six recent turns, oldest first: the rewriter's context
and the small-talk tone context. The answer path sees only the retrieved facts,
never raw history, for grounded modes.

## Per-claim provenance

There are exactly **two canonical citation tokens**, and the renderer trusts nothing
else:

| Token | Means |
| --- | --- |
| `{{cite:<memory-uuid>}}` | A claim grounded in a memory. Renders as an inspectable chip. |
| `{{unsourced}}` | A claim from the model's own knowledge. |

The answer model emits short `[F#]` and `[U]` markers; the backend post-processor
canonicalizes them and **strips every other bracketed or braced token**, counting
each as a citation violation. The grammar and the logic live once, in
`@cogeto/shared/citations.ts`. A malformed token can never leak, and an unsourced
segment carries no id, so it can never render as a source.

Web claims cite their web-source memories, whose chips carry URL and fetch time.

`[U]` is honored in every mode, because a model admitting a claim is its own
knowledge must never have that admission stripped into an unmarked claim. But the
answer prompt only *permits* it under a `GENERAL KNOWLEDGE: allowed` line, which the
input carries only for knowledge-class questions.

Honesty behaviours frozen in the answer prompt: the user's facts beat model
knowledge, and the answer states the tension when they conflict; unsure means saying
so rather than fabricating; "nothing on record" stays the answer for pure memory
questions, while a knowledge-class blend may follow that honest gap with clearly
marked general knowledge. **Any unmarked claim-bearing sentence in a blended answer
is defined as the model's failure.** The renderer's job stays mechanical, never
interpretive.

The renderer treats unsourced spans with a calm affordance ("Model knowledge, not
from your sources"), deliberately distinct from every citation chip. The marking is
a feature, not a warning.

## Relative dates are resolved by code

The extractor emits raw temporal expressions verbatim; a deterministic resolver
(chrono-node plus a custom pass) resolves each against the source's timestamp.
Weekday names resolve to the next occurrence strictly after the anchor, "by X" is a
`valid_until`, "in N days" adds to the anchor, and unresolvable expressions leave the
field null and are recorded so the drawer can flag them.

Models do calendar arithmetic unreliably; code does it exactly and testably, and the
same anchor gives the same date forever.

## Instance context: the now-block

The model would otherwise silently lack three things every human assistant has: the
date and time in the right timezone, who the user is, and which language to speak.

One row per user in `user_context`, owned by **infrastructure** rather than any
domain module, because the context feeds prompts and copy across retrieval,
connectors, ingestion, and the entrypoints alike. Fields are all optional except the
language pair: `display_name`, `company`, `role_title`, `about_work`, `timezone`
(a per-user IANA override; NULL means the instance zone applies), `preferred_language`,
and `language_strict`.

Every answer-tier and rewriter call gains a small labeled block, assembled in **one
place** so no surface invents its own phrasing:

- `NOW: <weekday>, <YYYY-MM-DD>, <HH:mm> (<zone>)`, always present, in the user's
  effective timezone.
- `USER CONTEXT (from the user's settings, not from memory, never cite): …`, with
  only the fields that are set. **Unset fields are absent**: no "company: unknown",
  no placeholders.
- `LANGUAGE: …`, the reply-language rule. Omitted for the rewriter, whose output is
  JSON.

### The honesty rule: context informs, it never sources

1. Context shapes interpretation and phrasing, but is **never a citable fact**. It
   gets no `[F#]`, because it is not a provided fact, and no `[U]`, because it is not
   model knowledge.
2. Context is **never presented as remembered**. "Where do I work?" answers from
   memory with citations when memory covers it, because facts always win. When only
   the settings know, the answer names its origin in words ("You've set MVT Solutions
   as your company in Settings"), with no chip and never a fabricated citation.
3. **Absent context is invisible.** With nothing set, behaviour is exactly what it
   was before the feature existed, and the model never remarks on unset fields.

One deliberate behaviour change: the zero-retrieval "nothing on record"
short-circuit yields to a model call when profile context is set, because the
settings are provided ground and a context question deserves the honest settings
answer. With no profile set, the deterministic path is byte-identical.

Context values never enter retrieval, embeddings, or the memory store.

## Language

`preferred_language` is a per-user locale (`en`, `hr`, extensible) plus an opt-in
`language_strict`. Defaults: `en`, mirroring on, strict off. Three rules:

- **Anchor.** Everything Cogeto *initiates* speaks `preferred_language`: the digest,
  attention lines, skill briefs, and the deterministic zero-answer replies (a
  deterministic string cannot mirror, so it follows the anchor).
- **Mirroring.** Direct replies mirror the user's message language by default, with
  `preferred_language` as the tie-breaker for mixed or ambiguous input. Detection is
  what the model does naturally under the `LANGUAGE` instruction; there is no
  separate language-detection service.
- **Strict.** Replies always come back in `preferred_language` regardless of input.

Deterministic paths stay deterministic: the digest builders and attention titles
carry en/hr string tables and take the owner's locale. **Translation may never
reorder or drop digest lines**, because the attention feed's dismissal keys index
into the line order. A locale read failure falls back to English rather than blocking
the path.

This field is deliberately the future key for UI internationalisation. The UI is
English for now, but the preference is per-user and already session-available to the
SPA, so translation can hang off it without a second plumbing pass.

## Derived context suggestions

Cogeto often already knows your company or role from your own memories. Asking you
to retype what the instance verifiably knows is friction; applying it silently would
blur the line between settings and memory. So it proposes, conservatively:

- **Deterministic candidates** from first-person patterns (en + hr) over your own
  active or approved memories, newest first, with past-tense or hypothetical phrasing
  vetoing the memory. **More than one distinct candidate value produces no
  suggestion**: conflicting evidence is silence, not a guess.
- **One pipeline-tier confirmation call** that can only confirm or reject the
  deterministic candidate, never invent or rewrite a value. Unsure means rejected; a
  gateway failure proposes nothing.
- **Settings shows the suggestion with its source**, and accepting records the
  provenance memory on the row. Dismissing is remembered, and the same value is never
  re-proposed.
- **User values win forever.** A set field is never re-derived, and a user edit
  clears the suggestion provenance, because the value is theirs now.

Computation happens on the Settings read: user-initiated, bounded, never ambient.

## Capture from chat

**No silent capture, ever.** Asking a question never creates a memory; the chat fast
path stays retrieval and answering only.

Capture is an explicit **"remember this"** action on a **user** message, which routes
that message through the normal pipeline and produces memories with
`source_type = 'chat'`. It is a transactional enqueue keyed on the message, so
double-clicks capture at most once.

- **Assistant messages are never captured.** The system's own output is not evidence
  about the world. The endpoint rejects any non-user message and the source reader
  loads only user messages, as defence in depth.
- **Private by default.** A chat statement is the user's own; promote it afterwards
  if you want.
- v1 captures the whole message. Span selection is deferred, and **no dead UI ships
  for it**.

## Conversations

**Memory is the continuity; conversations are workspaces.** The rewriter, router, and
answer assembly consume recent turns from the **current** conversation only. Cross-
conversation continuity happens through memory retrieval, never by leaking another
thread's raw turns into context. What Cogeto learned in one conversation is available
in every other, because knowledge lives in memory, not in the thread.

Conversations are per-user and owner-gated everywhere; a foreign or absent
conversation is NotFound, asserted **before** SSE headers flush. Active conversations
cap at 100 per user so the sidebar stays renderable; archiving is unlimited and
changes one boolean, keeping everything retrievable through memory.

The send endpoint requires a conversation id and inserts the message row with it
before routing, so a message always lands in the conversation it was sent to,
whatever the client does next. Switching mid-stream detaches the client and
contaminates nothing.

**Auto-title, conservatively.** After the first exchange only, one pipeline-tier call
proposes two to six plain words in the conversation's language, committed under a
guarded update. **A manual rename wins forever**: it sets `title_set_by_user`, and
even a mid-flight title job loses. A failed attempt parks in the dead-letter table
and the thread stays "New conversation".

**Deletion is the saga, by enumeration only.** Deleting a conversation enumerates its
messages' chat-derived memories and erases them in the same transaction and the same
receipt as any other source, with vectors removed by the worker leg. The confirm
dialog states exactly what goes, calls out `user_approved` memories, and names
archiving as the safe alternative.

## The surface

Provenance is the visual identity, not a chatbot skin. The question renders as a
confident heading; Cogeto answers as flush editorial prose along an evidence rail,
with no bubbles. Every claim carries a mono provenance chip, state-tinted by kind and
status. Each answer closes with a "stands on" manifest of the unique sources it drew
from. The composer is a docked command bar.

The frame is one centered column that fills the screen up to a roomy cap, with no
per-page width tiers, scrollbars hidden app-wide, and identity plus sign-out pinned
to the bottom of the sidebar. Full details, including the dual-theme token system and
the contrast rules, are in [`../design/README.md`](../design/README.md).
