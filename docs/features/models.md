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
affected configuration. This covers models that REFUSE the pin at request time too
(some hosted OpenAI families answer HTTP 400 to any pinned temperature): the refusal
is learned per model and the pin dropped, the same posture, discovered live.

**Parameter dialects are learned, never assumed.** OpenAI's newer model families
reject the legacy `max_tokens` field in favour of `max_completion_tokens`, while
every self-hosted OpenAI-compatible server and the older hosted models speak the
legacy dialect. Which dialect a model requires is a server-side fact nothing in its
name reveals, the same lesson vision and reasoning taught, so the adapter sends the
legacy dialect first (byte-identical for every configuration that worked before) and,
on the specific HTTP 400 that names the parameter, adapts the request, remembers the
fact per model for the life of the process, and retries. A model refusing both the
cap field and the temperature pin costs two extra round-trips, once ever. Probe
failures carry the server's own sentence rather than a bare status, so an admin
assigning a model reads the actual reason.

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

A fifth stored value, `ollama`, exists as a legacy type and cannot be created: a
local Ollama runtime is added as a **Self-hosted** provider pointed at its
OpenAI-compatible surface. A row carrying the legacy value keeps the dedicated
Ollama adapter, its per-tier timeouts and its configuration id, and renders as
Self-hosted with the runtime named in its subtitle.

**Four independent assignments** name a provider and a model: pipeline, answer,
embeddings, vision. Mixed configurations are ordinary rather than exceptional.
**Vision may be unassigned**, in which case the vision capability reports unavailable
exactly as it did before, and the reading ladder stops at OCR and says so.

**Two of the four tiers are capability-gated** (issue #571). Embeddings and vision
each need something the provider's adapter actually implements, so a provider that
cannot serve the tier is filtered out of the candidate list and refused by the API
before any probe runs:

| Tier | Served by | Not served by |
| --- | --- | --- |
| embeddings | Mistral, OpenAI, Self-hosted | Anthropic (it publishes no embeddings API) |
| vision | Mistral, OpenAI, Self-hosted | Anthropic |

The vision row is about **this code, not the vendors**: Anthropic's models are
multimodal, and `AnthropicModelGateway` has no image path, so the interface must
offer what the instance can do rather than what the vendor could. Both facts live in
one table (`ProviderTypeSpec`) with an environment-side twin (`VISION_CAPABLE`,
`EMBEDDING_CAPABLE`) that a spec holds to agreement, because when they drifted the
interface accepted a vision assignment the gateway could not honour and the failure
surfaced three layers away as the base gateway reporting the whole INSTANCE
unconfigured.

Being served by a type is necessary, not sufficient: whether the named model can see
is a **probed** question, which is why validating a vision assignment sends a real
image.

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

### One source of truth

**The database is the only source of model configuration, and the interface the only
writer.** The environment carries none of it: there is no seed, no fallback, and a
stale model variable left in `.env` has no effect at all. Two sources of truth for
one setting is how an instance ends up running a model nobody selected; this design
leaves exactly one. The single deliberate exception is the managed provider on a
hosted plan, described in its own section below: exactly one locked row, reconciled
at boot, with the rule intact for everything else.

An instance with **no provider configured is the normal first-run state**, not an
error: it boots clean, health stays ok, the interface shows a banner pointing at the
Providers page, and queued work waits and drains once a provider is added, without a
restart.

The eval harness deliberately resolves from the environment: it runs in CI against no
instance database, and pinning the configuration it measures is the point.

### Boot validation, and what still refuses

**Boot validation, never first-request failure.** An unresolvable configuration boots
with model features off and a typed error on use, rather than refusing to start, so an
admin is never locked out of the page that fixes it. What still refuses is the thing
that would corrupt data:

**Embedding-space integrity.** Each vector records its producing model, and the
index itself has durable state since migration 0053: a single `embedding_index_state`
row naming the active Qdrant collection and its dimension. At boot the app and worker
refuse to start when stored embeddings disagree with the active model or when the
collection's vector size disagrees with the recorded dimension. **Refuse, not
degrade**: a silently weaker retrieval surface is exactly the failure mode this
architecture exists to prevent. Since the managed rebuild shipped, **no interface
action can produce that state**: the guard is a net for states made by other means
(a restored backup, a direct database edit), and its message states exactly what
mismatched, the active and index configurations, and the `cogeto reindex` command
that repairs it. `reindex` is exempt and is the way out.

### Changing the embeddings model: the managed rebuild (V2.4 item 7.1, second half)

Changing the embeddings model is a **two-step operation in the interface**. The plan
step probes the candidate binding with a real embedding (which also yields the
model's TRUE dimension, never a registry guess), then states everything before
anything is saved: the corpus size in facts, the token estimate under the same
chars/4 accounting the budget meter charges, a duration extrapolated from the
probe's measured latency, that real model spend is involved, what search behaviour
will be during the rebuild, and whether the resulting configuration id has published
trust scores. Only explicit confirmation begins anything; from there it is automatic,
with no command and no restart.

**The pending model is recorded beside the active one**, on the memory-owned
`embedding_index_state` row, and a worker job (`memory.reindex_advance`, the
`import.advance` shape: a plain re-runnable pass under a single-flight lock)
re-embeds the whole corpus from Postgres, the source of truth, into a **new Qdrant
collection while the old one keeps serving untouched**. Resume state is presence in
the target collection, so a restart resumes exactly where it stopped; progress
(facts done against the total, phase, a rate-based time estimate, tokens spent) is
one cheap state-row read, shown live on the Models page, in the capabilities panel
and in the health report. The rebuild's embedding calls go through the ordinary
gateway factory, so the budget meter, the egress audit and redaction wrap them like
every other call; the spend is attributed to the admin who confirmed it, and an
exhausted daily budget **pauses** the rebuild visibly and resumes it later, never
bypasses the meter.

**The switch is one transaction**, under the exclusive side of an embedding-write
lock that every stamped-vector writer (pipeline stage 5, the memory embed job) takes
on the shared side: a final catch-up over rows ingested mid-rebuild, a gate-payload
resync for rows whose scope, status or sensitivity moved, an orphan sweep, a
verification that the point count matches the embeddable corpus, the per-row model
stamp, the assignment flip (through a port the worker root binds to the providers
module), and the state flip. A crash at any line rolls the whole switch back to a
still-running rebuild over a still-serving index. Every process picks the change up
within one version poll; the replaced collection is retired on a grace period so a
briefly stale process keeps serving a coherent old space, then dropped. The nightly
integrity sweep drops any stray rebuild collection a crash left behind.

**Serving policy: the old index serves throughout.** Qdrant holds both collections
for the duration (the resource cost is a second copy of the vectors), searches never
degrade, and users notice nothing but the progress banner. Gate parity in the new
collection is asserted by test, not assumed: the same `ensureCollection` path builds
the payload indexes, the same point construction carries the scope, status and
sensitive gates, and payload writes and deletions during the rebuild apply to both
collections so a mid-rebuild sensitive toggle or deletion cannot resurface after the
switch.

**Cancellation is always available**: it stops the job, drops the partial
collection, clears the pending state and audits the cancellation; the active
configuration was never touched. A rebuild whose passes keep failing parks as
`failed` with the error shown, and both resume and cancel remain offered.

**The operator path shares the implementation.** `cogeto reindex` (or
`docker compose run --rm worker npm run reindex`) rebuilds the active collection in
place for the mismatch-repair case, and `cogeto reindex --provider LABEL --model M`
drives the same managed rebuild and the same switch from the shell, for the instance
whose app will not start. `compose run` rather than `exec`, so it works while the
services crash-loop; the single-flight lock makes a live worker and the CLI
cooperate on the same rebuild instead of conflicting.

**Configuration identity.** The trust page's join key derives deterministically from
the resolved tiers, exactly as before: an exact match to a named preset gets the
preset's name, anything else a per-tier derivation, with a `-redacted` suffix when
redaction is on and a `--vis-` part when vision is bound. Any assignment change
changes the id, and each change is recorded with the id it produced and shown in the
interface. The assignment page shows the **published trust score for the exact
configuration in force**, and states **"not evaluated"** in words where none matches:
accuracy is never borrowed from a different configuration.

## The managed provider (hosted provisioning)

### The decision, on the record

The v1.7.0 rule was "the interface is the only place models are configured", and it
was made so that an instance can never run a model nobody selected. A hosting
platform provisions instances **unattended**: it renders configuration files and an
`.env`, runs the deploy compose, and re-renders and re-runs to change things. Nobody
is present to type a provider into a page. The owner therefore ratified a **narrow,
deliberate walk-back**: exactly ONE provider row per instance may be **managed**,
reconciled from provision-time configuration at boot. For every other provider, and
for every instance without the managed configuration, the v1.7.0 invariant stands
untouched, and `model-config-env.spec.ts` was amended consciously to permit exactly
the managed path while continuing to forbid everything else. The scope is fixed:
one row, by design, and never a general environment path back into model
configuration.

### The configuration surface

Two inputs, split by sensitivity, and the key in neither file:

- **`COGETO_MANAGED_PROVIDER_FILE`** names a JSON file the platform renders per
  instance, mounted read-only (`./managed-provider` in both compose channels). It
  carries the label, the endpoint, the map from **served model names** to upstream
  model identifiers, the initial tier assignments and the served names offered as
  answer choices. The committed template,
  [`project/infra/managed-provider.example.json`](../../project/infra/managed-provider.example.json),
  documents the shape with placeholders only and holds no real value of any kind.
- **`COGETO_MANAGED_PROVIDER_API_KEY`** arrives in the environment at bootstrap and
  is sealed under `COGETO_MASTER_KEY` at reconcile time exactly as an
  interface-entered key is: write-only forever, covered unchanged by the existing
  key-confinement invariant.

Both present: reconcile at boot, in both composition roots. Malformed file, file
without key, or key without file: **refuse the boot** with a message naming
precisely what is missing. Never guess, never partially apply. Neither present:
there is no managed provider and the product is byte-identical to today, which is a
tested property rather than an assumption.

### Reconciliation

The reconciler converges the single managed row (label, endpoint, sealed key, alias
map, answer options) and **touches nothing else**: a hand-configured provider,
including one pointing at the same endpoint, is byte-identical before and after
every boot, and the integration spec compares every field to hold that. Every
reconcile writes one audit entry carrying structural detail only, never the key and
never content. **Key rotation is re-render and restart**: the reconciler compares
the environment's key with the stored one and reseals on change, replacing the
previous ciphertext rather than keeping it beside a successor. No interface
involvement.

**Initial assignments apply only when the managed row is first created**, and only
to tiers nothing else holds; afterwards assignments belong to the instance, because
the customer may add their own providers and reassign tiers to them, and that
anti-lock-in property stays true. The managed card is locked, the instance is not.
Creation-time assignments are probed like any interface save: pipeline and answer
with a real completion, **vision with a real image** (a refused image leaves vision
unassigned, which is the designed honest answer, recorded in the log and the audit
entry), and embeddings with a real embedding whose returned dimension feeds the
ordinary managed rebuild, so the first embeddings assignment goes through the same
engine, probed dimension and one-transaction switch as every later one.

### Served names and the single translation seam

A provider row may carry a **model alias map**: served name to upstream identifier.
When it does, the served names are the only models that provider offers. Discovery
lists exactly the map's keys without asking the endpoint (whose own list would name
upstream identifiers); manual entry accepts only served names; the configuration
id, the egress trail, the index state, probes, errors and every page speak served
names. Translation to the upstream identifier happens at **exactly one seam**: the
OpenAI-compatible adapter, at the moment it writes the outgoing request's `model`
field. `model-alias-seam.spec.ts` asserts structurally that the map is dereferenced
nowhere else in the server or the SPA, because a second translation site is how an
upstream name eventually leaks into something published. Probes ride the same seam,
so validating a served name genuinely exercises the upstream model behind it.

Repointing a served name at a different upstream model is a material change to what
the id means. The honest path for the platform is to publish the changed model
under a **new served name** and say so in its own release notes; nothing in the
product pretends an alias is stable across upstream swaps.

One in-process exception is deliberate and narrow: **per-embedding-model
calibration keys by the geometry actually embedding.** The ambiguity and
reconciliation threshold tables are facts about a vector space, and a served
name is branding over the model that produces it, so the lookups key by
`embeddingGeometryId()` (the upstream identity behind a served embeddings
name) while every message, record and refusal carries the served name only.
Without this, a managed instance would fail the fail-loud unknown-model check
on every question despite running a measured model. The consequence for the
platform's catalog: the upstream model behind the served **embeddings** name
must be one the threshold tables know, or chat answering refuses loudly by
design, exactly as it does for any unmeasured self-hosted embeddings model.

### The embeddings rule

The dangerous change is the one you cannot see: swapping the upstream identity
behind the served embeddings model would change vector geometry while every query
keeps returning plausible results. The reconciler therefore **detects any change
affecting the embeddings tier** (the assigned served name disappearing from the
map, or the upstream identifier behind it changing) and **refuses the whole
reconcile and the boot**, applying nothing, with a message naming the honest path:
render the new model under a NEW served name alongside the old one, boot, and
switch through the managed rebuild in the interface or with
`cogeto reindex --provider <label> --model <new-served-name>`. A silent swap of
vector geometry is forbidden by construction, not by convention.

### What the customer sees

The managed card reads as **Cogeto**, with the brand mark reused from
`assets/brand` unmodified, and says in its own words that it is managed by the
hosting plan. It is read-only: no delete, no key field, no endpoint edit or
display, and its answer options are the configuration file's list. Everything else
keeps every affordance it has today, including adding any OpenAI-compatible
endpoint and reassigning tiers to it. The served names appear as the models, the
answer options feed the existing user-switchable answer mechanism unchanged, and
the Models page states **"not evaluated"** for the managed configuration, which is
exactly what the trust machinery is for: the managed configuration has no published
evaluation, and nothing borrows or fakes one.

## Local inference

A local runtime is a **provider flavor over the OpenAI-compatible adapter**, not a new
HTTP client and not a plain OpenAI configuration with knobs. Three reasons:

- **The configuration id must tell the truth.** A local model behind the hosted
  provider name would be indistinguishable from the hosted API in every published id,
  boot log, and Settings display.
- **Key semantics differ and must not leak.** The hosted provider types require a
  key (the interface refuses to save one without it), and that guard stays exactly
  as strict. Making the key optional to admit a local runtime would weaken
  validation for everyone.
- **Local defaults attach to the provider**, not the shared code: higher timeouts, the
  boot probe, the model-not-found hint. The adapter class stays one implementation with
  options, and the hosted paths stay byte-identical.

The base URL names the runtime root and has **no default**. No key is required, though
one is accepted for deployments behind an authenticating proxy. Since V2.4 item 7.1
the runtime is a provider RECORD like any other, added in the interface as a
**Self-hosted** provider pointed at its OpenAI-compatible surface; the reserved
legacy `ollama` type carries any row already on the dedicated adapter with its
per-tier timeouts and its configuration id unchanged.

**Local-inference realities.** First-token latency on consumer hardware is seconds,
and a 12B structured extraction can run minutes, so per-tier timeouts default far
higher and are independently configurable. Connection failures stay retryable, because
the runtime may be restarting or loading a model. A "model not found" is **fatal and
actionable**, naming the missing model and the `ollama pull` that fixes it, so no
retry loop ever hammers a runtime that cannot serve the model. The save-time probe
catches a missing model when the assignment is made, and the reindex entrypoint
probes too, since it is about to issue thousands of embedding calls.

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
