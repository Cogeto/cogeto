# Reasoning models: the thinking channel

**Owner-approved design, delivered in three parts: B (2026-08-04, the probed
capability and the maxTokens headroom), then A and C together (the channel,
its storage, and the display). Migration 0044.**

A reasoning model deliberates before it answers, and serves that deliberation
as a separate stream beside the answer. Cogeto supports this first-class
rather than working around it, under one governing principle: **thinking is a
CHANNEL, not content.** It is displayed, live and afterwards, because hiding
what the instance's own model said while deciding would be the opposite of
the product's posture; and it is never a source, never a citation, never a
measurement.

## The three honesty rules

1. **Thinking is never a source.** "Remember this" captures the user's own
   words; capture reads user rows only, structurally. Thinking cannot be
   captured, cited, verified, or contradicted, and the answer sanitizer and
   citation machinery read `content` alone.
2. **Thinking is never evaluated.** The golden set and the trust artifact
   measure answers. The eval cache records the text channel only, so a
   fixture cannot freeze what the harness must not measure.
3. **A run with thinking on is a different measurement.** The trust-artifact
   configuration id carries a `--reasoning` marker, appended at EMISSION time
   from the same probe the capability panel uses, because whether a binding
   reasons is a runtime fact the static resolver cannot know. A Mistral-routed
   run probes off and emits the unchanged id, so every existing artifact,
   gate, and cached fixture is untouched.

## Part B: the probed capability (delivered first, separately)

Whether a configuration reasons cannot be read off a model name — the same
weights are served both ways. So it is probed, like vision: a trivial prompt
at boot and per registry window, the answer surfaced on the capability panel
and boot banner. When on, every `maxTokens` is multiplied by
`COGETO_REASONING_HEADROOM` (default 4) for the bindings that reasoned,
because a cap sized for an answer is not sized for an answer plus its
deliberation; the exhausted-budget failure has its own named error instead of
masquerading as "returned no text". Details:
[`capabilities.md`](capabilities.md).

## Part A: the channel

`ModelGateway.completeStream` yields channel-tagged deltas
(`{channel: 'thinking' | 'text', text}`). The OpenAI-compatible adapter
surfaces `reasoning_content` (llama.cpp, DeepSeek), `reasoning` (OpenAI-style)
and `thinking` (Ollama) deltas on the thinking channel — and a thinking delta
also arms the Part B headroom, so live chat traffic teaches the adapter too.
Mistral yields text only; Anthropic maps `thinking_delta` blocks although
Cogeto never requests extended thinking. A non-reasoning model yields the
same bytes it always did, one field deeper.

The four decorators keep their contracts, two by explicit ruling:

- **The budget charges BOTH channels.** Thinking costs real tokens at the
  provider — on the reference reasoning model it is most of them — and a
  meter that ignored it would under-report spend several times over.
- **Redaction strips thinking, fail closed** — the vision posture.
  Re-identification maps pseudonyms back into the text a user reads; a
  reasoning model's deliberation interleaves pseudonym fragments the flush
  logic cannot bound. Under redaction the thinking channel does not exist:
  no delta, no empty disclosure.
- The egress audit counts both channels' characters (structural, never
  content); the tier router dispatches untouched.

## Part C: stored, streamed, shown

`chat_message.thinking` (migration 0044, nullable text) stores the
deliberation beside the answer it produced. A `thinking` SSE event streams
deltas live, interleaved with `token` events. The chat UI renders a collapsed
**Thinking** disclosure above the answer — streaming while the model
deliberates, expandable, reopenable on a stored answer — and renders NOTHING
when there is no thinking: a non-reasoning model leaves no empty affordance.

Erasure follows the answer. The answer-redaction cascade nulls `thinking` in
the same UPDATE that overwrites a citing answer's content, because reasoning
ABOUT an erased memory must not survive the citation that grounded it; row
deletion (message, conversation, source cascade) removes it implicitly, and
receipts are unchanged.

## What is deliberately NOT here

- No thinking in the answer prompt, the reply drafts, research synthesis, or
  any prompt assembly: the channel ends at the disclosure and the column.
- No evaluation surface: the harness consumes answer text and never reads the
  column or the channel.
- No configuration flag: display follows the model. A non-reasoning
  configuration behaves byte-identically to the pre-channel system, held to
  the reader-seam standard and tested as such.

## Tests

- `model-gateway/reasoning.spec.ts` (`reasoning_stream_channel`): labeled
  channels in order, headroom armed from a stream, non-reasoning streams
  unchanged.
- `model-gateway/redaction.spec.ts`: thinking stripped under redaction.
- `model-gateway/budgeted.gateway.spec.ts`: thinking charged.
- `chat/chat.integration.spec.ts` (`chat_thinking`): the SSE event, the
  stored column, the DTO, and the answer never containing the deliberation.
- `chat/chat-answer-cascade.integration.spec.ts`: thinking nulled with the
  redacted answer.
- `entrypoints/trust-scores.spec.ts`: the emission marker, on and off.
