# Security and trust model

The frame for everything else in this directory: what Cogeto protects, where the
trust boundaries are, which adversaries are in scope, and where each protection
sits. Read this first, then follow the links to the mechanism-specific documents.

## What Cogeto protects

Cogeto turns scattered work context (notes, documents, email) into **verifiable
memory** and lets human-approved agents act on it. The asset it guards is a
person's working memory and the personal data inside it. The product promise is
not "trust us" but **verifiable trust**: every claim traces to an inspectable
artifact, every deletion produces a signed receipt, and the software's own audits
are published. Security is what makes that promise real rather than marketing.

## Trust boundaries

Cogeto is deployed as a **single-tenant instance per customer**. That deployment
boundary is the primary isolation mechanism, and three internal seams carry the
rest:

- **The instance boundary.** One customer, one instance, its own Postgres, Qdrant,
  MinIO, and identity provider. Two customers never share a database, so one
  customer's data is not reachable from another's queries by construction. See
  [isolation-and-access](isolation-and-access.md).
- **The model-gateway seam.** The only place in the system that talks to an
  external model provider. Everything the model sees passes through here, which is
  where optional PII redaction lives. See
  [data-sovereignty-and-redaction](data-sovereignty-and-redaction.md).
- **The inbound-mail boundary.** The receive-only SMTP server is the one component
  exposed to the open internet. Sender authentication happens here. See
  [inbound-email-anti-spoofing](inbound-email-anti-spoofing.md).

## The protections, mapped

| Concern | Mechanism | Detail |
|---|---|---|
| Data is provably deleted | Deletion saga + hash-chained signed receipts + nightly integrity sweep | [deletion-and-receipts](deletion-and-receipts.md) |
| Every claim traces to a source | NOT-NULL provenance + admission checkpoint + orphan detection | [provenance-and-integrity](provenance-and-integrity.md) |
| Data stays in the instance | Single model seam, EU-hosted provider, optional fail-closed redaction | [data-sovereignty-and-redaction](data-sovereignty-and-redaction.md) |
| Agents never act unilaterally | Server-side approval state machine; execution is worker-only | [agent-approval-gate](agent-approval-gate.md) |
| Users see only what they should | Single-tenant boundary + `own OR shared` scope gate + OIDC auth | [isolation-and-access](isolation-and-access.md) |
| Forged email cannot inject memory | Envelope-based routing gated on SPF | [inbound-email-anti-spoofing](inbound-email-anti-spoofing.md) |
| Images and instances are hardened | Cosign-signed images + SBOM, per-tenant secrets, logging hygiene | [instance-and-supply-chain-hardening](instance-and-supply-chain-hardening.md) |

## Adversaries considered

**In scope for the design:**

- An internet sender forging a trusted address to inject false memory (handled by
  SPF sender authentication).
- An operator or infrastructure fault that silently drops or resurrects data after
  a deletion promise (handled by signed receipts + the integrity sweep + an
  external chain-tip anchor on every exported receipt).
- An external model provider that should never see raw personal data (handled by
  the single model seam and optional redaction).
- A second user on the same instance reading or mutating another user's private
  memory (handled by the scope gate; writes are owner-only).

**Explicitly out of scope for v1 (stated honestly, not hidden):**

- Volumetric denial-of-service and spam floods against inbound mail.
- Attacks that require a compromised host or stolen credentials as a precondition.
- Same-domain email impersonation, which SPF alone cannot stop (see the
  anti-spoofing doc's residual limits).
- Multi-tenant row-level isolation: v1 relies on the deployment boundary instead,
  a deliberate owner decision (decision
  [0019](../decisions/0019-cross-org-isolation-deployment-boundary.md)).

The authoritative scope for **vulnerability reports** is the repository-root
[`SECURITY.md`](../../SECURITY.md).

## The disciplines behind the claims

- **Published audits.** Every finding and its resolution is in
  [`../audits/`](../audits/) rather than asserted here.
- **Enforced invariants.** Scope-leak, deletion-cascade, approval-gate, and the
  golden-set eval gate are required CI checks; nothing merges without them green.
- **Honest residual limits.** Each mechanism doc states what it does *not* cover.
  A guarantee with unstated edges is worse than a modest one described precisely.
