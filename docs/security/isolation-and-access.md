# Tenant isolation and access control

This document explains how Cogeto keeps one customer's data separate from
another's, how a second user on the same instance is limited to what they should
see, and how requests are authenticated. The short version: isolation between
customers is a **deployment boundary**, and isolation between users on one instance
is a **scope gate** with owner-only writes.

## Between customers: a deployment boundary

Cogeto is **single-tenant** — one customer, one instance, its own Postgres,
Qdrant, MinIO, and identity provider organization. Two customers never share a
database, so there is no query in which one customer could observe another's rows.
This is a deliberate owner decision (decision
[0019](../decisions/0019-cross-org-isolation-deployment-boundary.md)): rather than
add an `org_id` column and an org predicate to every gate — redundant under
single-tenant and exactly the gold-plating the architecture warns against — the
deployment itself is the isolation. Introducing multi-tenant row gating would be a
data-model change requiring a fresh owner decision, and the doc records the exact
migration trigger (an `org_id` column + gate predicate + Qdrant payload field +
audit stamping) if consolidation is ever pursued.

## Between users on one instance: the scope gate

Within the single instance, memory visibility is governed by one gate:

> **Reads are gated `owner_id = caller OR scope = 'shared'`; writes are
> owner-only.**

- **Private** memory is visible only to its owner. **Shared** memory is visible to
  every user in the instance's organization (which, single-tenant, is everyone on
  the instance). The store's read filter and the Qdrant gate filter both implement
  this hard gate.
- **Every mutation is owner-only.** Transition, sensitive-toggle, scope change,
  content edit, uncertain-rejection, and the deletion saga all owner-check via row
  lock or enumeration and return `NotFound` to a non-owner (existence must not
  leak). The UI mirrors this by hiding controls, but **the server is the
  authority** (decision [0020](../decisions/0020-shared-scope-surface-rules.md)).
- **Scope changes are two-store and immediate.** Changing a memory's scope moves
  the Postgres row and the Qdrant payload together, so a `shared -> private` demote
  takes effect in vector search the instant it commits — a demoted leak is still a
  leak.
- **Reconciliation is intra-owner.** Contradiction resolution only ever compares a
  fact with the same owner's, same-scope memories, so cross-owner contradictions
  are structurally impossible and there is nothing to resolve across users.

The cross-user behaviour (private isolated by owner, shared visible to peers,
mutations owner-only, scope changes propagate) is proven exhaustively by the
memory module's cross-user test suite.

## Authentication and sessions

Requests are authenticated through the **identity seam**, which validates a bearer
token against the instance's OIDC identity provider. Two properties are worth
stating precisely (decision
[0026](../decisions/0026-token-revocation-window-and-receipt-chain-anchor.md),
ruling 1):

- **Local pre-validation.** Before trusting anything, the seam decodes the JWT
  locally and checks the issuer against the configured issuer and the audience
  against the SPA client id — a malformed or wrong-audience token is rejected with
  no network call.
- **A stated, bounded token-revocation window.** Validated principals are cached
  briefly so the identity provider is not called on every request. The cache TTL
  is **10 seconds**, so a revoked or expired token is re-validated and rejected
  within about ten seconds. This is an inherent latency/security trade of any
  validation cache; it is deliberately bounded and documented rather than hidden,
  and accepted as an operational property under the single-tenant boundary.

Administrative surfaces are gated separately (an admin flag on the authenticated
principal); a guard exported from the identity module enforces it on admin-only
routes.

## The audit trail

`GET /api/audit` is an org-scoped, read-only trail. Within the single org, members
share one organization, so the trail legitimately shows all members' actions — but
it records **ids, statuses, reasons, and counts only, never memory or note
content** (decision 0020, ruling 6). Deletion receipts are visible to the actor
who performed the deletion (the owner), while instance-wide chain verification and
the integrity sweep still cover every receipt — that is operator integrity, not a
per-user view.

## Residual notes

- **Same-org members are trusted with shared scope.** Shared means org-wide by
  design; there is no per-memory ACL beyond private/shared in v1.
- **A defense-in-depth follow-up is flagged, not done:** some writers omit
  `org_id` (their rows are NULL-org and reach the reader via the `IS NULL` arm).
  Under single-tenant this is the same one org; stamping `org_id` on every writer
  is the right step before any future where more than one org shares
  infrastructure (ties to decision 0019).

## Where this lives in the code

- Scope gate + owner-only mutations: `project/src/memory/` (store `visibleTo`,
  Qdrant `buildGateFilter`, aggregate methods)
- Identity seam (token validation, admin guard): `project/src/identity/`
- Audit reader: `project/src/entrypoints/` (`audit.integration.spec.ts`)
- Design: decisions
  [0019](../decisions/0019-cross-org-isolation-deployment-boundary.md),
  [0020](../decisions/0020-shared-scope-surface-rules.md),
  [0026](../decisions/0026-token-revocation-window-and-receipt-chain-anchor.md)
