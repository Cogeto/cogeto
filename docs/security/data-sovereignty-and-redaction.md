# Data sovereignty and PII redaction

Cogeto is built so your data stays in your instance. This document explains the
single seam through which any data can reach an external model, the EU-hosted
default, and the optional redaction layer that pseudonymizes personal data before
it ever leaves the box — including its honest limits.

## One seam, no side doors

Every LLM and embedding call in the system goes through the **model-gateway
seam**. No provider SDK or API is used anywhere else, and a module-boundary check
in CI enforces that — the Mistral client cannot be imported outside the seam. This
is what makes the data-egress story auditable: there is exactly one place to
inspect, not a scatter of call sites.

Your durable data never leaves the instance regardless: Postgres, Qdrant, and
MinIO all run inside your deployment. The only outbound traffic is the model calls
themselves, and those all pass through the seam.

## The EU-hosted default

v1 routes model and embedding calls to the **Mistral API** under EU-hosted,
zero-retention DPA terms. Per-task tiers keep cost and exposure proportionate: a
cheaper model for high-volume ingestion, a stronger one for the answers you read.
Nothing about the architecture phones home — there is no telemetry channel back to
the project.

## The optional redaction layer

For deployments that must not send raw personal data to any external API, the
redaction profile (`--profile redaction`) inserts a **local, CPU-only NER
sidecar** in front of the model seam. When it is on, a decorator around the gateway:

- **Pseudonymizes** recognized entities in every outbound request — completion,
  extraction, **and embeddings** — before the request reaches the provider, and
  **re-identifies** the response on the way back.
- **Fails closed.** If the sidecar is unreachable, the call fails rather than
  sending plaintext. Real text is never sent as a fallback.

Embeddings are deliberately redacted too (decision
[0023](../decisions/0023-redaction-embedding-tradeoff.md)). The tempting shortcut —
"the vector store is local, so skip embeddings" — is wrong: Qdrant is local, but
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
that Postgres holds un-redacted for the owner inside the instance — which softens
the embedding cost materially. The eval harness measures both arms (`npm run eval`
with and without `REDACTION_ENABLED`), recorded in `docs/eval/history.md`.

Because vectors under redaction are made from pseudonymized text, toggling
redaction between builds would produce an inconsistent index — so it is an
**instance-lifetime setting**, not a per-run flag, and a reindex re-embeds
consistently with the current mode. Local embeddings (which remove the trade-off
entirely by keeping the embed call inside the trust boundary) are the planned v1.x
path.

## The residual limitation (must be stated to users)

Redaction covers the **configured entity categories only**: person, organization,
location, email, phone, IBAN, credit card, monetary amount, Croatian OIB, and any
custom recognizers. It **cannot guarantee that no sensitive information leaves in
free text** — an unusual name the recognizer misses, or a sensitive fact phrased
without a named entity, can still pass through. It is a strong, honest reduction
of exposure, not a proof of zero leakage. Any compliance description must say
"category-scoped redaction," never "no PII leaves the box."

## Where this lives in the code

- The seam and factory: `project/src/model-gateway/` (`model-gateway.service.ts`,
  `factory.ts`, `mistral.gateway.ts`)
- Redaction decorator: `project/src/model-gateway/redacting.gateway.ts`
- Sidecar: `project/services/redaction/`
- Tests: `project/src/model-gateway/redaction.spec.ts`
- Design: decision [0023](../decisions/0023-redaction-embedding-tradeoff.md);
  seam rationale in `project/src/model-gateway/README.md`
