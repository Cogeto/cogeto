# 0040 — Model provider adapters: bring-your-own-key (Post-v1 Priority 3)

**Status:** Accepted. **Context:** the model gateway (§A.10) is a provider-neutral
seam that v1 routes entirely to Mistral. Post-v1 Priority 3 makes the
"plug in any model" claim literally true: the gateway gains OpenAI-compatible and
Anthropic adapters, selected per instance by configuration, proven per
configuration on the trust page (the schema was built for this — decision 0032).
This record freezes the design before code. Issues #173/#174/#175.

## Ruling 1 — The provider contract

A provider adapter is a `ModelGateway` implementation (the existing abstract
seam class) built for one upstream API. What every adapter must provide:

- **`complete` / `completeStream`** — free-text completion for a concrete model
  (the tier→model mapping lives in configuration, not in callers). `complete`
  reports provider token usage when the upstream returns it (Ruling 4).
- **`extractStructured`** — schema-valid JSON or a typed failure (Ruling 2).
- **Error classification** — every upstream failure surfaces as a
  `ModelGatewayError` with the existing `retryable` flag: HTTP 429 and ≥ 500 and
  network failures are retryable (and retried with the existing bounded
  exponential backoff before surfacing); 4xx is fatal. Callers keep branching on
  `retryable`, never on provider types.
- **`embed` / `embeddingModelId`** — OPTIONAL capability. A provider without an
  embeddings API declares it by construction: its adapter is never eligible for
  the embeddings tier (boot validation enforces this — Ruling 3), and its
  `embed()` throws a fatal `ModelGatewayError` if reached anyway. Anthropic is
  the current case: no embeddings API.
- **`reachable`** — a cheap, cached (30 s) health probe (models-list endpoint),
  as the Mistral gateway already does (QS-35).

**No new SDK dependencies.** The OpenAI-compatible and Anthropic adapters speak
plain HTTPS via the platform `fetch` (Node 22) — the APIs are small, stable REST
surfaces, a vendor SDK would be a new dependency needing sign-off for no
capability we use, and the no-leakage rule is easier to prove when the only
provider "client" is a URL inside the gateway. `@mistralai/mistralai` stays for
the existing adapter.

**Tier routing.** Configurations are per-task-family (Ruling 3), so tiers may
point at different providers. A `TierRoutedModelGateway` dispatches each call by
its tier (`pipeline`/`answer` → that tier's adapter+model; `embed`/
`embeddingModelId` → the embeddings binding). When all three tiers resolve to
one provider the factory returns that adapter directly — the mistral-default
path is byte-identical to v1. The redaction (B.8) and budget (QS-2) decorators
wrap the routed gateway exactly as before: **decorator order budget → redaction
→ provider(s) is unchanged and applies identically to every provider** — there
is structurally no per-provider bypass, and the factory remains the single
construction point.

**Sampling.** Deterministic structured extraction (decision 0035) holds where
the provider accepts a temperature: Mistral and OpenAI-compatible send
`temperature: 0` for structured calls and the configured temperature for free
text. Current Anthropic models **reject sampling parameters**, so the Anthropic
adapter sends none; determinism for what Cogeto remembers rests on the JSON
contract plus validation (Ruling 2). This is a documented, provider-forced
deviation from 0035, stated in the trust notes whenever an Anthropic
configuration is published. Anthropic's Messages API requires `max_tokens`; the
adapter defaults it to 8192 when the caller sets none.

## Ruling 2 — Structured output normalization

One internal contract, unchanged for callers: the gateway takes a Zod schema and
returns validated JSON or a typed failure. The pipeline stays provider-agnostic.

Each adapter's job is only to get **syntactically valid JSON text** from its
upstream; schema enforcement is shared gateway code:

- **Mistral** — `responseFormat: { type: 'json_object' }` (unchanged).
- **OpenAI-compatible** — `response_format: { type: 'json_object' }` (the widest
  compatibility across OpenAI-compatible endpoints; `json_schema` mode is not
  frozen in because compatible servers support it unevenly).
- **Anthropic** — no JSON mode on current models, and assistant prefill is
  rejected by them; the adapter appends a strict JSON-only instruction to the
  system prompt and defensively strips a Markdown code fence before parsing.

The **repair-and-retry rules** are extracted from the Mistral adapter into
shared gateway code and apply identically everywhere: non-JSON output is a fatal
typed failure (no retry — the §B.4 evals gate on first-shot shape); JSON that
fails the Zod schema gets exactly ONE corrective retry carrying the validation
issues; a second failure is a fatal typed failure. Provider/transport errors
keep their Ruling-1 classification.

## Ruling 3 — Configuration is per-task-family; embeddings are guarded

Because Anthropic exposes no embeddings API, a configuration names a provider
and model **per tier** — `pipeline`, `answer`, `embeddings` — and the eval
grader follows the answer tier unless explicitly overridden (harness-only
override). Mixing families is normal (e.g. Anthropic answers over Mistral
embeddings and pipeline).

- **Boot validation, never first-request failure:** unknown provider name,
  provider selected without its API key, a tier without a resolvable model, an
  unknown preset, or the embeddings tier pointing at a provider without an
  embeddings API each REFUSE BOOT with a message naming the exact variable to
  fix. `mistral-default` remains the default preset; a bare
  `COGETO_MISTRAL_API_KEY` keeps meaning exactly what it meant in v1, and a
  fully unconfigured instance still boots with model features off (typed error
  on use), as today.
- **Embedding-space integrity:** `memory.embedding_model` (decision 0005 r3)
  already records each vector's producer. Changing the embeddings binding mid-
  life is supported, but mixing embedding spaces silently is not: at boot the
  app and worker check for stored embeddings whose model differs from the
  active one and **refuse to start** (frozen: refuse, not degrade — a silently
  weaker retrieval surface is the failure mode §A.4 exists to prevent), naming
  the reindex command. `npm run reindex` (which exists to re-embed exactly
  those rows) is exempt and is the way out. Recall-only rows
  (`embedding_model IS NULL`) don't block.

**Configuration identity.** The configuration id (the trust page's join key,
decision 0032) derives deterministically from the resolved tiers: a resolved
configuration exactly equal to a named preset's expansion gets the preset's
name (`mistral-default` — published history keeps its id); anything else gets
`pipe-<provider>-<model>--ans-<provider>-<model>--emb-<provider>-<model>`
(slugged), with the existing `-redacted` suffix when redaction is on. Any tier
change changes the id. The id is logged at every boot and shown read-only in
Settings; the legacy `mistral-custom` id is retired (it conflated all custom
model sets under one key — no published release used it).

**Keys are operator-set instance environment, full stop** (backlog decision
restated): never entered through the UI, never stored in the database, never
logged, never returned by any endpoint. Settings displays the configuration; it
does not capture secrets.

## Ruling 4 — Token usage normalization into budgets

Adapters normalize provider-reported usage (Mistral `promptTokens`/
`completionTokens`, OpenAI `prompt_tokens`/`completion_tokens`, Anthropic
`input_tokens`/`output_tokens`) into an optional `usage` field on
`CompletionResult`. The budget decorator charges real reported usage when
present and falls back to the documented chars/4 estimate otherwise (streams,
structured extraction, embeddings — where the seam's return shapes carry no
usage channel). The budget stays a safety ceiling, not billing (QS-2); the
change only makes the ceiling more honest where providers report truth.

## Ruling 5 — Proven per configuration, owner-run for alternates

`npm run eval` / `npm run eval:chat` resolve the SAME configuration the
instance would boot with (one resolver, so the emitted `configuration.id` and
models are exact by construction) and emit it in `--emit-json`. Alternate-
provider keys are NOT repo secrets and must not become any: CI keeps running
the default configuration only; alternate configurations are owner-run and
merged into the release's trust-scores file as additional `--partial` inputs
(flow documented in `docs/notes/model-providers.md`). Each published
configuration appears as its own entry on the trust page — "model-agnostic" as
published evidence, not a claim.
