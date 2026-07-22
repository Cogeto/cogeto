# 0041 — Local model runtime: the Ollama provider and preset (Post-v1 Priority 4)

**Status:** Accepted. **Context:** Post-v1 Priority 4 brings model inference home:
the instance can run tiers on a self-hosted Ollama runtime reachable over the
operator's private network, with local embeddings, gated by eval parity per task
and language (backlog Priority 4). Priority 3 (decision 0040) built the doorway —
an OpenAI-compatible adapter with a configurable base URL — and this record
freezes how the local runtime walks through it. Issues #181/#182/#183.

## Ruling 1 — Ollama is a provider flavor over the OpenAI-compatible adapter

`ollama` becomes a first-class `ModelProviderId` whose adapter **is** the
existing `OpenAiCompatibleModelGateway`, constructed with local options — not a
new HTTP client, and not a plain `openai` configuration with knobs. Why the
flavor and not the knobs:

- **The configuration id must tell the truth.** The trust page's join key
  (decision 0032/0040) derives from provider + model per tier. A local Gemma
  behind `openai/…` would be indistinguishable from the hosted OpenAI API in
  every published id, boot log, and Settings display. `emb-ollama-bge-m3` is
  honest; `emb-openai-bge-m3` is not.
- **Key semantics differ and must not leak.** The hosted `openai` provider
  refuses boot without `COGETO_OPENAI_API_KEY` (0040 ruling 3) — that guard
  stays exactly as strict. Ollama requires no real key; making the key optional
  on the hosted path to admit a local runtime would weaken validation for
  everyone.
- **Local defaults attach to the provider, not the shared code**: higher
  timeouts, the boot probe, the model-not-found hint (Ruling 2) are all keyed
  off `provider === 'ollama'` in configuration; the adapter class stays one
  implementation with options, and the hosted paths are byte-identical to
  Priority 3.

**Base URL.** `COGETO_OLLAMA_BASE_URL` names the runtime **root** (e.g.
`http://10.0.0.1:11434`, `http://localhost:11434`, a LAN or WireGuard address —
all equally valid; the address is deployment configuration). The gateway
derives `<root>/v1` for the OpenAI-compatible surface and `<root>/api/tags` for
probes; a trailing `/v1` is stripped defensively so either form works. There is
**no default** — a tier bound to `ollama` without the variable refuses boot
naming it (0040 boot-validation rule: fail at startup, never at first request).

**Key.** None required. `COGETO_OLLAMA_API_KEY` is accepted for deployments
that put the runtime behind an authenticating reverse proxy; otherwise the
adapter sends a dummy bearer (`ollama`), which the runtime ignores. The
resolver synthesizes the dummy key so the "referenced provider without a key
refuses boot" rule keeps holding for every *hosted* provider unchanged.

**Embeddings capability:** `ollama` is embeddings-capable (bge-m3 and friends),
so it joins `EMBEDDING_CAPABLE`.

## Ruling 2 — Local-inference realities

- **Per-tier timeouts, independently configurable, defaulting higher for
  local.** First-token latency on consumer hardware is seconds, not
  milliseconds, and a 12B structured extraction can run minutes.
  `COGETO_OLLAMA_TIMEOUT_PIPELINE_MS` / `_ANSWER_MS` / `_EMBEDDINGS_MS`,
  defaults 300 000 / 300 000 / 120 000. Implemented as an abort timeout on the
  adapter's HTTP calls, per tier. Hosted adapters keep today's behavior
  (no explicit timeout) — nothing changes for them.
- **Retry classification.** Connection-refused and other network failures stay
  retryable (0040 ruling 1 already classifies status-less errors as
  retryable — the runtime may be restarting or loading a model). HTTP 404
  `model not found` is **fatal and actionable**: the error names the missing
  model and the fix (`ollama pull <model>` on the Ollama host). No retry loop
  ever hammers a runtime that cannot serve the model.
- **Boot probe, never first-request failure.** When any tier resolves to
  `ollama`, the app and worker probe the runtime at startup: `GET /api/tags`
  (short timeout) proves reachability, and every ollama-bound model must appear
  in the tag list (matched with or without the `:tag` suffix — `bge-m3`
  matches `bge-m3:latest`). Unreachable runtime or missing model **refuses
  boot** with the URL or the exact `ollama pull` command. The reindex
  entrypoint probes too — it is about to issue thousands of embedding calls.
- **Health.** The ollama adapter's `reachable()` probes `<root>/api/tags`
  (cached 30 s like every provider probe, QS-35), so the existing health
  surface reports the local runtime's reachability with no new endpoint.

## Ruling 3 — Networking is deployment configuration, not code

The containers must be able to reach the runtime's address. Nothing in the
code assumes a topology: the base URL is fully configurable (Ruling 1), and the
operator notes (`docs/notes/local-models.md`, operator runbook) document the
one real consideration — reaching a WireGuard address from the Docker bridge
requires the **host** to route and forward for the Docker subnet (or host
networking, or running Ollama on the LAN/localhost instead). No compose change
is baked in; the default stack stays exactly as it is.

## Ruling 4 — The `ollama-local` preset; mixed configurations are overrides

`COGETO_PROVIDER_PRESET=ollama-local` puts all three tiers on the local
runtime: pipeline and answer on `gemma3:12b` (the preset default — any
`COGETO_MODEL_*` var overrides it, as with every preset), embeddings on
`bge-m3`. Configuration ids derive exactly as in 0040 ruling 3: the preset name
on an exact match, else the per-tier derivation (so hosted-answer-over-local-
embeddings publishes as `pipe-…--ans-mistral-…--emb-ollama-bge-m3`). Mixed
postures are **documented per-tier override examples, not new presets** — the
id derivation already names them precisely, and presets multiply while
overrides compose.

## Ruling 5 — Local embeddings and the index guard

`bge-m3` (1024 dimensions, multilingual — covers Croatian) registers in the
vector store's dimension table; the lookup tolerates Ollama `:tag` suffixes so
`bge-m3:latest` resolves the same. The embedding-space guard (0040 ruling 3)
is extended to cover **dimension** disagreement explicitly, not only model-name
disagreement: at boot the app and worker also compare the live collection's
vector size against the active model's dimension and refuse to serve on
mismatch, naming the reindex command. Reindex remains the way out — it already
recreates the collection at the new dimension (issue #179) and re-embeds from
Postgres, the §A.4 source-of-truth rebuild; it now reports done/total progress
and is resumable by construction (a re-run reuses rows already stamped with
the active model whose points hold vectors).

## Ruling 6 — Parity-gated migration, proven per configuration

Nothing migrates to local wholesale. A task family is recommended local only
where the local configuration reaches **eval parity per task and per language**
against the `mistral-default` baseline, measured by the same two suites and
published per configuration (0040 ruling 5). CI keeps gating on
`mistral-default` only; local runs are owner-run (the runtime lives on the
owner's network) and their trust-score partials merge into releases like any
alternate configuration. Where all-local misses parity on a task, the docs
state the measured gap plainly and the mixed preset (hosted generation + local
embeddings) remains the recommended local posture — the `ollama-local` preset
stays available for the operator who accepts the tradeoff knowingly. Nothing
hides a dip (standing backlog rule).

**Budgets and redaction are unchanged**: the factory constructs the ollama
adapter inside the same single construction point, so the budget → redaction →
provider decorator order wraps local calls identically to hosted ones — tokens
are counted even at zero cost; the accounting stays uniform
(`budget_applies_all_providers`, `redaction_applies_all_providers` extend to
the local provider).
