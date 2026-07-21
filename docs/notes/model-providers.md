# Model providers: bring-your-own-key (Post-v1 Priority 3)

Working notes for decision 0040 (issues #173/#174/#175). The gateway, Mistral-only
in v1 behind the provider-neutral seam, now has OpenAI-compatible and Anthropic
adapters, selected per instance by configuration and proven per configuration on
the trust page.

## The shape

- **Adapters** (`project/src/model-gateway/`): `MistralModelGateway` (the
  existing SDK-based one), `OpenAiCompatibleModelGateway` and
  `AnthropicModelGateway` (plain `fetch` — no new dependency; the
  `no_provider_leakage` test greps for SDK names AND endpoint hostnames outside
  the gateway). A `TierRoutedModelGateway` dispatches per tier when a
  configuration mixes providers; single-provider configurations bypass it.
- **One resolver** (`provider-config.ts`): app, worker, every bare entrypoint
  and both eval harnesses resolve configuration through
  `resolveModelProviders(env, { redacted })` — the boot log, Settings and the
  trust-score emission can never disagree. Invalid combinations throw at boot
  with the exact variable to fix.
- **Decorators unchanged**: budget → redaction → provider(s), for every
  provider (`redaction_applies_all_providers`, `budget_applies_all_providers`).

## Structured output normalization (the one contract)

Callers hand the gateway a Zod schema and get validated JSON or a typed
failure. Adapters only produce syntactically valid JSON text:

| Provider | JSON mechanism |
|---|---|
| Mistral | `responseFormat: { type: 'json_object' }` |
| OpenAI-compatible | `response_format: { type: 'json_object' }` (the widest-compatible mode; the endpoint must support it) |
| Anthropic | No JSON mode on current models (and assistant prefill is rejected): a strict JSON-only instruction is appended to the system prompt and a Markdown fence is stripped defensively before parsing |

The shared repair loop (`provider.ts#structuredWithRepair`) is identical
everywhere: non-JSON → fatal typed error, no retry; schema-invalid JSON → ONE
corrective retry carrying the Zod issues; second failure → fatal typed error.
Sampling: Mistral/OpenAI-compatible send `temperature: 0` on structured calls
(decision 0035); current Anthropic models reject sampling parameters, so the
Anthropic adapter sends none — a documented provider-forced deviation, noted
whenever an Anthropic configuration is published.

## The embeddings rule

Anthropic exposes no embeddings API, so configurations are **per-task-family**:
`pipeline`, `answer`, `embeddings` each name a provider+model, and the
embeddings tier must name an embeddings-capable provider (mistral | openai) —
validated at boot. Changing the embeddings provider OR model marks the vector
index stale: the app and worker **refuse to boot** ("mixed embedding spaces")
until `docker compose exec worker npm run reindex` has re-embedded the rows
whose `memory.embedding_model` differs (decision 0005 r3 mechanics, reused).
Reindex itself is exempt — it is the way out.

## Configuration cheat sheet

```sh
# Default (unchanged v1 behavior): just the Mistral key.
COGETO_MISTRAL_API_KEY=…

# Preset — all three tiers at once (mistral-default | openai-default | anthropic-answer)
COGETO_PROVIDER_PRESET=anthropic-answer
COGETO_ANTHROPIC_API_KEY=…     # answer tier
COGETO_MISTRAL_API_KEY=…       # pipeline + embeddings

# Or per tier (overrides the preset):
COGETO_PROVIDER_ANSWER=openai  COGETO_MODEL_ANSWER=gpt-4o  COGETO_OPENAI_API_KEY=…
# Any OpenAI-compatible endpoint (the Priority-4 doorway):
COGETO_OPENAI_BASE_URL=http://ollama:11434/v1
```

The configuration id (Settings + boot log + trust scores) is the preset name on
an exact match, else `pipe-…--ans-…--emb-…`, with `-redacted` appended when
redaction is on. Keys are operator-set environment only — never entered in the
UI, stored, logged, or served by any endpoint.

## Owner flow: evals on an alternate configuration

Alternate-provider keys are NOT repo secrets and must not become any — CI keeps
gating on `mistral-default` only; alternate configurations are **owner-run**:

1. On a machine with the alternate keys exported (or in the repo-root `.env`),
   set the configuration env vars, then run both suites into one partial file:

   ```sh
   COGETO_PROVIDER_PRESET=anthropic-answer \
     npm run eval -- --emit-json /tmp/anthropic-answer.json
   COGETO_PROVIDER_PRESET=anthropic-answer \
     npm run eval:chat -- --emit-json /tmp/anthropic-answer.json
   ```

   The harness prints `configuration: <id> (…)` at start — verify it is the
   configuration you meant; the emitted JSON carries exactly that id and those
   models (`eval_emission_config_correct`). Different configurations go to
   DIFFERENT files (the merge refuses mismatched ids).

2. At release time, pass each configuration file as an extra `--partial` to the
   publisher (same flow as the redacted configuration, decision 0032):

   ```sh
   node scripts/ci/publish-trust-scores.mjs --version vX.Y.Z --sha <commit> \
     --partial trust-default.json --partial /tmp/anthropic-answer.json \
     --note "anthropic-answer run by the owner on <date>; Anthropic rejects sampling parameters, so structured calls run without temperature pinning (decision 0040 r1)"
   ```

   Each partial becomes its own `configurations[]` entry on the trust page.

3. **Grader override** (comparability caveat): `COGETO_PROVIDER_GRADER` /
   `COGETO_MODEL_GRADER` re-bind only the chat coverage grader (it otherwise
   follows the answer tier). Cross-configuration comparisons are honest only if
   the grader is held constant — when publishing several configurations, either
   leave the grader on each configuration's answer tier (the default, stated
   here) or pin one grader for all runs and say so in a release note.

## Gotchas

- `settings_display_accurate` lives on the server (`entrypoints/model-config.spec.ts`)
  because the SPA section is a plain render of `GET /api/settings/model-config`.
- The env-consistency test tracks `env.COGETO_*` property reads; the resolver
  reads via an indexed helper, so the new vars are wired through
  `docker-compose.yml` (which the test also accepts) — they must stay there.
- Anthropic requires `max_tokens`; the adapter defaults it to 8192 when the
  caller sets none.
