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

Whether a configuration reasons cannot be read off a model name: the same
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
and `thinking` (Ollama) deltas on the thinking channel, and a thinking delta
also arms the Part B headroom, so live chat traffic teaches the adapter too.
Mistral surfaces its `thinking` content chunks the same way (issue #573):
a Magistral turn arrives as `{type: 'thinking', thinking: [...]}` inside the
message content, and that chunk is routed to the thinking channel and
deliberately kept OUT of the answer text, which is what the storage,
citation and redaction paths assume. Anthropic maps `thinking_delta` blocks
although Cogeto never requests extended thinking. A non-reasoning model
yields the same bytes it always did, one field deeper.

Until #573 the Mistral adapter yielded text only, and dropped the thinking
chunk on the floor: a Magistral model answered with no visible deliberation,
and because `probeReasoning` reads the `reasoned` flag off a non-streaming
`complete()` result that the adapter never set, the `reasoning` capability
probed **off for every Mistral binding whatever the model was**. Whether an
adapter accounts for the channel is now a structural check
(`model-gateway/adapter-parity.spec.ts`), because this was the third
capability in a row to land in one adapter and go missing from another.

The four decorators keep their contracts, two by explicit ruling:

- **The budget charges BOTH channels.** Thinking costs real tokens at the
  provider, and on the reference reasoning model it is most of them; a
  meter that ignored it would under-report spend several times over.
- **Redaction strips thinking, fail closed**, the vision posture.
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
**Thinking** disclosure above the answer (streaming while the model
deliberates, expandable, reopenable on a stored answer) and renders NOTHING
when there is no thinking: a non-reasoning model leaves no empty affordance.

Erasure follows the answer. The answer-redaction cascade nulls `thinking` in
the same UPDATE that overwrites a citing answer's content, because reasoning
ABOUT an erased memory must not survive the citation that grounded it; row
deletion (message, conversation, source cascade) removes it implicitly, and
receipts are unchanged.

## The thinking toggle (issue #424)

Thinking is also COSTLY: at self-hosted speeds it multiplies every call's
latency. So the mode is controllable per request, three ways:

- **Chat**: a per-device toggle in the composer, default on. Off asks the
  model to answer directly, with the measured non-thinking sampler profile
  (temperature 0.7, top_p 0.80, presence_penalty 1.5, the anti-loop guard
  free-form generation needs); on pairs the thinking profile (temperature
  1.0, top_p 0.95, no penalty). No deliberation means no disclosure.
- **Structured tasks** (extraction, verification, reconciliation, anchoring,
  the auto-title) and **vision page reads** disable thinking unconditionally:
  they discard reasoning by design, so they never pay for it. Temperature
  stays 0 and no sampler profile applies; the presence penalty tested
  unnecessary against JSON and is deliberately not sent there.
- **The mechanism**: a provider-neutral `thinking: on | off` on the gateway
  request. The OpenAI-compatible adapter maps it to
  `chat_template_kwargs.enable_thinking` (the flag the reference llama.cpp
  build honours; top-level `reasoning: "off"` tested not honoured) on
  SELF-HOSTED endpoints only, because the hosted API rejects unknown
  parameters. Mistral and Anthropic ignore the mode; a request that sets no
  mode is byte-identical to before; a server that ignores the flag still
  works, because the probe and the headroom stay as the safety net. A pinned
  adapter temperature (the eval harness pins 0) suppresses the sampler
  profile but never the flag, so measurements stay deterministic.

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
