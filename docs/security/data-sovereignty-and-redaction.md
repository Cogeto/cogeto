# Data sovereignty and PII redaction

Cogeto is built so your data stays in your instance. This document explains the
single seam through which any data can reach an external model, the EU-hosted
default, and the optional redaction layer that pseudonymizes personal data before
it ever leaves the box, including its honest limits.

## One seam, no side doors

Every LLM and embedding call in the system goes through the **model-gateway
seam**. No provider SDK or API is used anywhere else, and a module-boundary check
in CI enforces that: the Mistral client cannot be imported outside the seam. This
is what makes the data-egress story auditable: there is exactly one place to
inspect, not a scatter of call sites.

Your durable data never leaves the instance regardless: Postgres, Qdrant, and
MinIO all run inside your deployment. The only outbound traffic is the model calls
themselves, and those all pass through the seam.

## The EU-hosted default

Which models an instance calls is **its own choice, made in the interface**
(Providers, then Models) and stored in its own database; the environment
carries no model configuration at all. The recommended default is the
**Mistral API** under EU-hosted, zero-retention DPA terms, and an instance can
equally run every tier against a self-hosted endpoint, in which case no model
call leaves the box at all. Per-tier assignment keeps cost and exposure
proportionate: a cheaper model for high-volume ingestion, a stronger one for
the answers you read. Whatever the choice,
**nothing about the architecture phones home**: there is no telemetry channel
back to the project. How configuration works:
[`../features/models.md`](../features/models.md).

## The optional redaction layer

For deployments that must not send raw personal data to any external API, the
redaction profile inserts a **local, CPU-only NER sidecar** in front of the
model seam. When it is on, a decorator around the gateway:

- **Pseudonymizes** recognized entities in every outbound request: completion,
 extraction, **and embeddings**: before the request reaches the provider, and
 **re-identifies** the response on the way back.
- **Fails closed.** If the sidecar is unreachable, the call fails rather than
 sending plaintext. Real text is never sent as a fallback.

### How to turn it on, and where it runs

**On a customer instance** (the supported deployment path):

```sh
sudo cogeto features enable redaction
```

That adds the `redaction` profile, sets `REDACTION_ENABLED=1` and
`REDACTION_REQUIRED=1` (so the instance refuses to boot without the sidecar
rather than quietly regressing to plaintext), pulls the signed
`cogeto/cogeto-redaction` image and verifies its cosign signature, and waits
for the sidecar to report healthy. On a source checkout the equivalent is
`REDACTION_ENABLED=1 docker compose --profile redaction up --build`.

Once it is on, `/api/health` and the System panel report the `redaction`
capability, and an unreachable sidecar is a **loud** state there, not a silent
one, because that is precisely when model calls start failing.

**Availability: both stacks, no caveat.** `cogeto/cogeto-redaction` is built,
pushed, cosign-signed and SBOM-attested by the release pipeline beside the
other three images, and the `redaction` profile is in the customer compose, so
a customer instance runs this exactly as a source checkout does. This is the
one place that statement is made; the runbook and `.env.example` point here.

### What it costs to run

Two costs an operator should decide about before enabling it, not after:

- **Memory.** Roughly 0.7 to 1 GB resident for the spaCy `en_core_web_lg`
 model, capped at 2 GB. It is the single largest addition to an instance's
 footprint; the 8 GB minimum already budgets for it.
- **Retrieval quality**, quantified in the next section. Because vectors are
 built from pseudonymized text, this is an **instance-lifetime** setting:
 switching later means a reindex.

Embeddings are deliberately redacted too. The tempting shortcut:
"the vector store is local, so skip embeddings", is wrong: Qdrant is local, but
the *embedding call itself* goes to the provider, so real entity text in that
request would leave the box and defeat the whole guarantee. Redacting embeddings
is the only honest option in v1.

## The cost, stated plainly

Pseudonymization has a real retrieval cost, and the docs state it rather than hide
it:

- **Semantic loss:** a pseudonymized sentence carries less meaning than a named
 one, so nearest-neighbour ranking is weaker.
- **Cross-document inconsistency:** pseudonyms are numbered per call, so the same
 person may be a different token in two different notes, which specifically blunts
 entity-anchored retrieval.

Extraction and answering are affected far less (within one call the model sees
consistent pseudonyms and the gateway re-identifies the result), and hybrid
retrieval also uses full-text and entity signals over the **real** stored text
that Postgres holds un-redacted for the owner inside the instance, which softens
the embedding cost materially. The eval harness measures both arms (`npm run eval`
with and without `REDACTION_ENABLED`), recorded in `docs/eval/history.md`.

Because vectors under redaction are made from pseudonymized text, toggling
redaction between builds would produce an inconsistent index, so it is an
**instance-lifetime setting**, not a per-run flag, and a reindex re-embeds
consistently with the current mode. Local embeddings remove the trade-off
entirely by keeping the embed call inside the trust boundary, and they are
available today: assign the embeddings tier to a self-hosted provider, which
runs as the managed rebuild described in
[`../features/models.md`](../features/models.md).

## The residual limitation (must be stated to users)

Redaction covers the **configured entity categories only**: person, organization,
location, email, phone, IBAN, credit card, monetary amount, Croatian OIB, and any
custom recognizers. It **cannot guarantee that no sensitive information leaves in
free text**: an unusual name the recognizer misses, or a sensitive fact phrased
without a named entity, can still pass through. It is a strong, honest reduction
of exposure, not a proof of zero leakage. Any compliance description must say
"category-scoped redaction," never "no PII leaves the box."

## Web research: minimise, disclose, approve

Web research (Priority 5) adds one more thing that deliberately leaves the box:
a search query. Pseudonymising a query breaks it, so the mechanism there is
**minimisation plus disclosure plus approval**: a local pipeline-tier pass
rewrites the query to its least-identifying serving form, the user sees exactly
what would be sent (with a one-line reason for what was removed or kept), edits
it freely, and nothing reaches a search engine without their explicit approval.
The sent query is recorded in the provenance of every memory the research
produces. Pages are fetched by the tenant's own instance (no third-party
research API) via the self-hosted SearXNG container, which keeps no query logs.
The honest claim is "you see precisely what leaves, and you approve it":
never "nothing leaves." Decisions
0044 /
0045; mechanics in
[`../features/web-research.md`](../features/web-research.md).

## Where this lives in the code

- The seam and factory: `project/src/model-gateway/` (`model-gateway.service.ts`,
 `factory.ts`, `mistral.gateway.ts`)
- Redaction decorator: `project/src/model-gateway/redacting.gateway.ts`
- Sidecar: `project/services/redaction/`
- Tests: `project/src/model-gateway/redaction.spec.ts`
- Seam rationale in `project/src/model-gateway/README.md`
