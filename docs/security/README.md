# Security and safety

The single entry point for how Cogeto protects data and how to verify it. Cogeto's
product promise is verifiable trust, so its security posture is documented in the
open rather than asserted. This page indexes everything; the linked files are the
source of truth.

Some material stays in its conventional home and is linked from here rather than
moved: the vulnerability-reporting policy lives at the repository root where GitHub
surfaces it, and tests live next to the code they exercise (the project convention,
enforced by the module-boundary check in CI). This page is the map; those are the
territory.

## Reporting a vulnerability

- **[`SECURITY.md`](../../SECURITY.md)** (repository root) — how to report
  privately, what to expect, and what is in and out of scope. **Customer
  instances are out of scope without the owner's written authorization; the public
  demo sandbox is explicitly in scope.**

## How the protections work

Start with the overview, then the mechanism-specific docs:

- **[Security and trust model](security-overview.md)** — the anchor: what Cogeto
  protects, the trust boundaries, which adversaries are in and out of scope, and a
  map of where every protection sits. **Read this first.**
- **[Verifiable deletion and signed receipts](deletion-and-receipts.md)** — the
  deletion saga across Postgres/Qdrant/MinIO, hash-chained signed receipts, the
  integrity sweep, and how to verify a receipt yourself.
- **[Provenance and integrity](provenance-and-integrity.md)** — every claim traces
  to an inspectable source; how that is enforced and how an orphan is caught within
  one sweep cycle.
- **[Data sovereignty and PII redaction](data-sovereignty-and-redaction.md)** — the
  single model seam, the EU-hosted default, and the optional fail-closed redaction
  layer (with its honest limits).
- **[Agents propose, humans approve](agent-approval-gate.md)** — the server-side
  approval state machine; consequential actions execute only from `approved` state,
  only in the worker.
- **[Tenant isolation and access control](isolation-and-access.md)** — the
  single-tenant deployment boundary, the `own OR shared` scope gate with owner-only
  writes, and how requests are authenticated.
- **[Inbound email: sender authentication and anti-spoofing](inbound-email-anti-spoofing.md)**
  — why a forged `From` cannot inject memory: envelope-based routing, SPF
  authentication, the refusal gates, residual limits, and how to test it live.
- **[Instance and supply-chain hardening](instance-and-supply-chain-hardening.md)**
  — verifying signed images, per-instance secrets, encryption, and logging hygiene.

The behaviour behind each protection is documented with the feature it belongs to:

| Concern | Where the mechanism is documented |
|---|---|
| Deletion saga, receipts, encryption | [`deletion-and-receipts.md`](deletion-and-receipts.md) |
| Human-approval gate for agent actions | [`agent-approval-gate.md`](agent-approval-gate.md), [`../features/approvals.md`](../features/approvals.md) |
| Single-tenant isolation, scope gates | [`isolation-and-access.md`](isolation-and-access.md), [`../features/memory.md`](../features/memory.md) |
| PII redaction at the model seam | [`data-sovereignty-and-redaction.md`](data-sovereignty-and-redaction.md), [`../features/models.md`](../features/models.md) |
| Provenance integrity | [`provenance-and-integrity.md`](provenance-and-integrity.md) |
| Token revocation, receipt-chain anchoring | [`isolation-and-access.md`](isolation-and-access.md), [`deletion-and-receipts.md`](deletion-and-receipts.md) |
| Demo sandbox gating | [`../features/demo-sandbox.md`](../features/demo-sandbox.md) |
| Inbound email routing and spoofing stance | [`inbound-email-anti-spoofing.md`](inbound-email-anti-spoofing.md), [`../features/sources.md`](../features/sources.md) |
| Web research: SSRF guard, query minimisation, budgets | [`data-sovereignty-and-redaction.md`](data-sovereignty-and-redaction.md), [`../features/web-research.md`](../features/web-research.md) |

## The tests that enforce it

Tests are co-located with the code they exercise under `project/src/` and run on
every CI build. The security-relevant ones:

| Area | Test |
|---|---|
| Inbound-mail intake and SPF gate | `project/src/connectors/email-intake.integration.spec.ts` |
| Allowlist routing | `project/src/connectors/email-allowlist.integration.spec.ts` |
| Intake endpoint auth guard | `project/src/connectors/mail-intake.guard.spec.ts` |
| Deletion cascade and receipts | `project/src/memory/deletion.integration.spec.ts`, `email-deletion-cascade.integration.spec.ts`, `web-deletion-cascade.integration.spec.ts` |
| Forgotten sweep | `project/src/memory/sweep-arms.integration.spec.ts` |
| PII redaction at the model seam | `project/src/model-gateway/redaction.spec.ts` |
| Extraction guard | `project/src/ingestion/pipeline/extract-guard.spec.ts` |
| Web fetcher SSRF/robots/caps + internal-only discovery | `project/src/connectors/web-fetch.spec.ts`, `web-discovery.spec.ts` (+ `searx_internal_only` in `deployment-hardening.spec.ts`) |
| Research gate: no query without approval, sent-query record | `project/src/connectors/research-gate.integration.spec.ts`, `research-flow.integration.spec.ts` |
| Deployment hardening / secret preflight | `project/src/entrypoints/deployment-hardening.spec.ts`, `secret-preflight.spec.ts` |
| Audit-log integrity | `project/src/entrypoints/audit.integration.spec.ts` |

The invariant tests named in the definition of done (scope-leak, deletion-cascade,
approval-gate, golden-set eval gate) are required checks — nothing merges without
them green.

## Supply chain and instance hardening

Release images are cosign-signed with an attached SBOM, instances generate their
own secrets, and logs never carry personal data. The full picture — image
verification, secrets, encryption, and logging hygiene — is in
[instance-and-supply-chain-hardening](instance-and-supply-chain-hardening.md).
Verification commands are also in the Docker Hub overviews
([`../dockerhub/`](../dockerhub/)) and the [deployment guide](../deployment.md).
