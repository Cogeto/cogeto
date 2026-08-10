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

## Configuration lives in the database (V2.4 item 7.1)

Providers, models and their API keys are **records an administrator manages in the
interface**, not environment variables. `.env` keeps bootstrap only: database
credentials, the instance master key, and instance configuration.

**Providers are records.** A display label the admin chooses, a type, an endpoint
where the type needs one, an encrypted key where the type needs one, and the health
its last probe reported. Four types: **Mistral**, **OpenAI**, **Anthropic**, and
**Self-hosted** (any OpenAI-compatible endpoint: llama.cpp, Ollama, vLLM, LM Studio,
or a proxy in front of several). Several providers of the same type are ordinary, so
the **label** is what tells them apart and is unique.

A fifth stored value, `ollama`, exists but cannot be created: it is what the seed
writes for an instance already bound to the local Ollama runtime, so that instance
keeps its adapter, its per-tier timeouts and its configuration id exactly. It renders
as Self-hosted with the runtime named in its subtitle.

**Four independent assignments** name a provider and a model: pipeline, answer,
embeddings, vision. Mixed configurations are ordinary rather than exceptional.
**Vision may be unassigned**, in which case the vision capability reports unavailable
exactly as it did before, and the reading ladder stops at OCR and says so.

**Model discovery OFFERS; it never decides.** The provider's models endpoint is
queried and its answers are offered, and **manual entry is always allowed**, because a
proxied deployment can legitimately serve models its `/models` route does not
advertise. The reference deployment is precisely that case: one vhost where
`/v1/embeddings` reaches one process and everything else another, so the embeddings
model never appears in the list. A self-hosted endpoint's list is labelled as possibly
partial for the same reason.

**Validation is a probe, never a pattern match.** Saving an assignment sends the tier's
actual job through the real adapter: a one-token completion, a one-string embedding, a
32-pixel image. "embed" in a model name is a naming convention, and a GGUF model is
multimodal only when its projector is loaded, and neither fact is readable from a
string.
Failures are classified so an admin is sent to the right place: **unreachable**,
**key rejected**, **model not served**, **no embeddings route**, **image refused**,
**timed out**. An embeddings tier pointed at a type with no embeddings API (Anthropic)
is refused before anything is sent.

**Keys are encrypted at rest** with the instance master key (`COGETO_MASTER_KEY`,
AES-256-GCM, fresh IV per encryption), which stays in the environment because a key
that guards a database cannot live inside it. Decryption happens only where a call is
made. **A saved key is never returned to the client, never appears in a response, a
log line, an error, an export or a health field**, and is never rendered after entry:
the interface shows that a key is present and offers to replace it. The sealed column
is selected in exactly one function, and `key-confinement.spec.ts` asserts that
structurally rather than by convention. The master key is optional until something
needs encrypting (a self-hosted endpoint with no auth needs none) and then the failure
names it and the command that generates one. **It is data-bound**: rotating it makes
every stored provider key unreadable, with no recovery but re-entry.

**Changes take effect without a restart.** One live configuration object per process
is mutated in place, so every consumer that holds it is current; the gateway rebuilds
its whole decorated stack when the version changes, and the worker, which has no
request to notice a change on, polls the version column every 30 seconds.

**One model choice belongs to the user.** The **answer** tier is switchable per person,
among the models an admin enabled; pipeline, embeddings and vision stay admin-only,
because they decide what gets remembered, how it is indexed and what gets read off a
page. A user's stored choice is an opaque option id, never a model string, so call
sites still request a tier and the seam still owns the mapping. A retired option falls
back to the assigned tier rather than failing the next question, and the egress trail
names the model that actually received the bytes.

### Seeding, and the one source of truth

On the **first start after upgrading**, the environment's model configuration is read
once and written as the equivalent providers and assignments. The claim is atomic on a
single state row, so of two processes starting together exactly one seeds. An instance
with no model configuration at all is marked seeded with nothing, which is the honest
translation.

**After that, the database is authoritative.** The environment's model variables are
**ignored**: not merged, not a lower-priority fallback. They may sit in `.env` forever
and change nothing, which is why the upgrade note says to delete them. Two sources of
truth for one setting is how an instance ends up running a model nobody selected. The
boot log states the source in one word for exactly this reason.

The eval harness deliberately still resolves from the environment: it runs in CI
against no instance database, and pinning the configuration it measures is the point.

### Boot validation, and what still refuses

**Boot validation, never first-request failure.** An unresolvable configuration boots
with model features off and a typed error on use, rather than refusing to start, so an
admin is never locked out of the page that fixes it. What still refuses is the thing
that would corrupt data:

**Embedding-space integrity.** Each vector records its producing model. At boot the
app and worker refuse to start when stored embeddings disagree with the active model
or when the collection's vector size disagrees with the active model's dimension,
naming the reindex command. **Refuse, not degrade**: a silently weaker retrieval
surface is exactly the failure mode this architecture exists to prevent. `reindex` is
exempt and is the way out.

**Which is why the embeddings tier cannot be reassigned in the interface yet.** V2.4
item 7.1 is the configuration half; the **managed reindex is the second half and ships
next**. Until it does, the embeddings row explains that changing the model requires
rebuilding the vector index and names the operator command
(`docker compose exec worker npm run reindex`) as the interim path. The refusal is
server-side, so it holds for any caller, not just the page.

**Configuration identity.** The trust page's join key derives deterministically from
the resolved tiers, exactly as before: an exact match to a named preset gets the
preset's name, anything else a per-tier derivation, with a `-redacted` suffix when
redaction is on and a `--vis-` part when vision is bound. Any assignment change
changes the id, and each change is recorded with the id it produced and shown in the
interface. The assignment page shows the **published trust score for the exact
configuration in force**, and states **"not evaluated"** in words where none matches:
accuracy is never borrowed from a different configuration.

## Local inference## Local inference

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

The base URL names the runtime root and has **no default**. No key is required, though
one is accepted for deployments behind an authenticating proxy. Since V2.4 item 7.1
the runtime is a provider RECORD like any other: an existing Ollama-bound instance is
seeded to the reserved `ollama` type so nothing about its adapter or its configuration
id changes, and a new local runtime is added as a **Self-hosted** provider pointed at
its OpenAI-compatible surface.

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
