# Models: providers, tiers, and local inference

All model and embedding calls go through a single **model-gateway seam**. No provider
SDK or endpoint appears anywhere else, and an architecture test keeps it that way.
Cogeto is model-agnostic literally, not aspirationally: every published configuration
is measured and appears as its own entry in the trust scores.

## Tiers, not model strings

Call sites request a **tier**; the tier-to-model mapping lives in configuration.

| Tier | Used by | Default |
| --- | --- | --- |
| `pipeline` | Extraction, verification, reconciliation, query rewriting, minimisation, skill planning, conversation titles | a small model |
| `answer` | Chat synthesis, research synthesis, skill briefs, the eval grader | a stronger model |
| `embeddings` | Every vector | a multilingual embedding model |

The user-facing synthesis path needs a stronger model than the high-volume ingestion
path. Tiering raises quality where it is read without moving the ingestion cost floor.
The pipeline never calls free-text completion at all, which is the token-control point
that keeps ingestion and research economical.

## The provider contract

An adapter is a `ModelGateway` implementation for one upstream API, providing:

- **`complete` / `completeStream`**, reporting provider token usage when available.
- **`extractStructured`**, returning schema-valid JSON or a typed failure.
- **Error classification.** Every upstream failure surfaces as a `ModelGatewayError`
  with a `retryable` flag: HTTP 429, 5xx, and network failures are retryable and are
  retried with bounded exponential backoff before surfacing; 4xx is fatal. Callers
  branch on `retryable`, never on provider types.
- **`embed` / `embeddingModelId`**, an **optional** capability. A provider without an
  embeddings API is never eligible for the embeddings tier, enforced at boot, and its
  `embed()` throws a fatal typed error if reached anyway. Anthropic is the current case.
- **`reachable`**, a cheap 30-second-cached health probe.

**No new SDK dependencies.** The adapters speak plain HTTPS through the platform
`fetch`. These are small, stable REST surfaces; a vendor SDK would be a dependency
needing sign-off for no capability used, and the no-leakage rule is far easier to
prove when the only provider client is a URL inside the gateway.

**Structured output.** One internal contract: the gateway takes a Zod schema and
returns validated JSON or a typed failure, so the pipeline stays provider-agnostic.
Each adapter's job is only to get syntactically valid JSON text from its upstream;
schema enforcement is shared. Repair rules apply identically everywhere: non-JSON
output is a fatal typed failure with no retry, because the evals gate on first-shot
shape; JSON that fails the schema gets exactly **one** corrective retry carrying the
validation issues; a second failure is fatal.

**Determinism.** Structured extraction is always `temperature: 0` in production, and
the eval harness pins temperature 0 on all its calls including grading. What Cogeto
remembers must not depend on a sampling dice roll, and JSON-schema extraction has no
use for creative variance. Production chat answering keeps the provider default,
because conversational quality may legitimately benefit from sampling. Where a
provider rejects sampling parameters the adapter sends none, and determinism rests on
the JSON contract plus validation; that deviation is stated in the trust notes for any
affected configuration.

## Configuration is per tier

A configuration names a provider and model per tier, and mixing families is normal.

**Boot validation, never first-request failure.** An unknown provider, a provider
selected without its key, a tier with no resolvable model, an unknown preset, or the
embeddings tier pointing at a provider with no embeddings API each **refuse boot**
with a message naming the exact variable to fix. A fully unconfigured instance still
boots with model features off and a typed error on use.

**Embedding-space integrity.** Each vector records its producing model. Changing the
embeddings binding is supported; mixing embedding spaces silently is not. At boot the
app and worker refuse to start when stored embeddings disagree with the active model
or when the collection's vector size disagrees with the active model's dimension,
naming the reindex command. **Refuse, not degrade**: a silently weaker retrieval
surface is exactly the failure mode this architecture exists to prevent. `reindex` is
exempt and is the way out.

**Configuration identity.** The trust page's join key derives deterministically from
the resolved tiers. An exact match to a named preset gets the preset's name; anything
else gets a per-tier derivation, with a `-redacted` suffix when redaction is on. Any
tier change changes the id. It is logged at every boot and shown read-only in Settings.

**Keys are operator-set instance environment, full stop.** Never entered through the
UI, never stored in the database, never logged, never returned by any endpoint.
Settings displays the configuration; it does not capture secrets.

## Local inference

A local runtime is a **provider flavor over the OpenAI-compatible adapter**, not a new
HTTP client and not a plain OpenAI configuration with knobs. Three reasons:

- **The configuration id must tell the truth.** A local model behind the hosted
  provider name would be indistinguishable from the hosted API in every published id,
  boot log, and Settings display.
- **Key semantics differ and must not leak.** The hosted provider refuses boot without
  its key, and that guard stays exactly as strict. Making the key optional to admit a
  local runtime would weaken validation for everyone.
- **Local defaults attach to the provider**, not the shared code: higher timeouts, the
  boot probe, the model-not-found hint. The adapter class stays one implementation with
  options, and the hosted paths stay byte-identical.

The base URL names the runtime root and has **no default**; a tier bound to the local
provider without it refuses boot. No key is required, though one is accepted for
deployments behind an authenticating proxy.

**Local-inference realities.** First-token latency on consumer hardware is seconds,
and a 12B structured extraction can run minutes, so per-tier timeouts default far
higher and are independently configurable. Connection failures stay retryable, because
the runtime may be restarting or loading a model. A "model not found" is **fatal and
actionable**, naming the missing model and the `ollama pull` that fixes it, so no
retry loop ever hammers a runtime that cannot serve the model. At boot, every
local-bound model must appear in the runtime's tag list or the process refuses to
start; the reindex entrypoint probes too, since it is about to issue thousands of
embedding calls.

**Parity-gated migration.** Nothing migrates to local wholesale. A task family is
recommended local only where it reaches eval parity **per task and per language**
against the hosted baseline, measured by the same two suites and published per
configuration. CI keeps gating on the default configuration; local runs are owner-run
and merge into releases like any alternate configuration. Where all-local misses
parity, the docs state the measured gap plainly and the mixed posture (hosted
generation over local embeddings) stays the recommended local setup. **Nothing hides
a dip.**

## Redaction, and what it costs

With the `redaction` profile on, a local CPU-only NER sidecar pseudonymises sensitive
entities **before any external model call** and re-identifies the response. It **fails
closed**: unreachable means model calls fail, never that plaintext is sent.

**Embeddings are redacted too.** The framing that "the vector store is local, so
exempt embeddings" does not hold: Qdrant is inside the instance, but the embedding
call itself goes to the provider, and real entity text in that request would defeat
the entire guarantee.

The cost, stated plainly. Pseudonymisation degrades embedding retrieval two ways:
semantic loss, because a pseudonymised sentence carries less meaning for
nearest-neighbour ranking; and cross-document inconsistency, because pseudonyms are
numbered per call, so a query's pseudonyms need not match a stored fact's. Extraction
and answering are affected far less, since within a single call the model sees
consistent pseudonyms and the gateway re-identifies the result. Hybrid retrieval
softens the embedding cost materially, because full-text and entity signals run
against the real stored text inside the instance. Running the embeddings tier locally
removes the trade-off entirely.

**The residual limitation, which must be stated to users.** Redaction covers the
configured entity categories only. It **cannot guarantee that no sensitive information
leaves in free text**: an unusual name the NER misses, or a sensitive fact phrased
without a named entity, can still pass through. It is a strong, honest reduction of
exposure, never a proof of zero leakage. Redaction is described as category-scoped and
never as "no PII leaves".

Because redaction changes what gets embedded, the toggle is an instance-lifetime
setting rather than a per-run flag; reindexing with it flipped would produce an
inconsistent index.

## Budgets

A per-user daily budget decorator wraps the whole surface. Adapters normalize
provider-reported usage into one shape, and the decorator charges real reported usage
where present, falling back to a documented estimate otherwise. The budget is a safety
ceiling, not billing. It is applied at the single construction point, so it counts
tokens even for a local runtime at zero cost and the accounting stays uniform.
