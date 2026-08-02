# Tenant isolation and access control

This document explains how Cogeto keeps one customer's data separate from
another's, how a second user on the same instance is limited to what they should
see, and how requests are authenticated. The short version: isolation between
customers is a **deployment boundary**, and isolation between users on one instance
is a **scope gate** with owner-only writes.

## Between customers: a deployment boundary

Cogeto is **single-tenant**: one customer, one instance, its own Postgres,
Qdrant, MinIO, and identity provider organization. Two customers never share a
database, so there is no query in which one customer could observe another's rows.
This is a deliberate owner decision: rather than
add an `org_id` column and an org predicate to every gate, redundant under
single-tenant and exactly the gold-plating the architecture warns against, the
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
 authority**.
- **Scope changes are two-store and immediate.** Changing a memory's scope moves
 the Postgres row and the Qdrant payload together, so a `shared -> private` demote
 takes effect in vector search the instant it commits: a demoted leak is still a
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
stating precisely:

- **Local pre-validation.** Before trusting anything, the seam decodes the JWT
 locally and checks the issuer against the configured issuer and the audience
 against the SPA client id: a malformed or wrong-audience token is rejected with
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
share one organization, so the trail legitimately shows all members' actions, but
it records **ids, statuses, reasons, and counts only, never memory or note
content**. Deletion receipts are visible to the actor who performed the deletion
(the owner).

**Chain verification is instance-wide; its numbers are not** (V2.0 item 3.7). The
ledger is one hash chain, and a per-user subset of a hash chain verifies nothing, so
`GET /api/receipts/verify` still walks every confirmed receipt and the verdict it
returns is the real one. What an ordinary authenticated caller gets back is scoped:
the verdict, plus the confirmed and pending counts of **their own** receipts, and no
error string. An administrator gets the instance-wide report, error string included,
because a broken chain is an operator's problem. Before this, any authenticated user
could read the instance's total deletion counts and a receipt id belonging to someone
else, the same class of cross-user operational data that made `/api/integrity` and
`/api/jobs` admin-only. The integrity sweep remains admin-only in full.

**What leaves the instance is recorded** (V2.0 item 3.7). Two egress paths write to
the trail alongside the passport export, which has been audited since the 2.0 audit's
SEC-9:

- **`file.downloaded`**: minting a presigned URL for a stored original, with the
  object key, the URL's lifetime, and whether the reader was the owner or a same-org
  peer reading a shared file. A refusal writes nothing: no bytes moved.
- **`model.egress`**: one entry per call through the model gateway, carrying the tier asked
  for, the provider and resolved model it routed to, whether redaction was in the
  chain, how much went and came back as counts, latency, and success. Never the
  prompt, never the completion, never a fragment of either. In a product whose
  position is that models are rented and knowledge is owned, "which of my content
  went to a rented model, and when" has to be answerable from the trail.

Retention and export for the trail as a whole are V2.4 item 7.4.

## The data plane runs least-privilege (decision record, audit 2.0 wave 3)

Before wave 3 of the 2.0 audit remediation, the app and worker connected to
Postgres as the cluster superuser and to MinIO with the root credential
(SEC-1, SEC-2), and the Zitadel bootstrap PAT stayed valid until 2030
(SEC-16). Every guarantee below existed only as long as the application chose
not to violate it. This section is the decision record for the fix.

### The role model: one identity per trust boundary

| Identity | Used by | Holds |
|---|---|---|
| `cogeto_app` | app + worker (and the ops CLIs run inside them) | table-level DML on the application schema, row-policy access to the Graphile queue. No DDL, no TRIGGER privilege, no CONNECT on the `zitadel` database, owns nothing |
| `cogeto_migrate` | the migrate one-shot only | owns the `cogeto` database and every object in it; the only role that runs migrations |
| `zitadel_admin` | Zitadel's own `start-from-init` | CREATEDB + CREATEROLE, not superuser; owns the `zitadel` database |
| `zitadel` | Zitadel runtime | unchanged, was already least-privilege |
| `postgres` (superuser) | the `db-init` one-shot only | break-glass; never handed to a long-running service |

`db-init` (a one-shot psql step, `project/infra/docker/postgres-init/db-init.sql`)
creates the roles, revokes PUBLIC connect on both databases, sets default
privileges, and adopts objects a pre-wave-3 stack created as the superuser.
It is idempotent and re-syncs passwords from `.env` on every `compose up`,
which is what makes the three DB credentials rotatable by
`cogeto configure --regenerate`.

### The grant set

The migrate entrypoint re-converges `cogeto_app`'s grants after every
migration run (`infrastructure/migrations.ts`, `applyAppRoleGrants`), so a new
table is readable the moment it exists. The deliberate carve-outs:

- **`audit_log`: SELECT + INSERT only.** UPDATE/DELETE are refused by the
  append-only trigger regardless, but the trigger could be disabled by a table
  owner; `cogeto_app` is not one, and `ALTER TABLE ... DISABLE TRIGGER` fails
  with "must be owner". TRUNCATE, which would bypass the row trigger entirely,
  is not granted.
- **`deletion_receipt`: no DELETE, no TRUNCATE.** The freeze trigger already
  refuses mutation of confirmed receipts; the missing grants make the ledger
  undroppable and untruncatable by the runtime.
- **`cogeto_migrations`: read-only.** Health and the capability registry read
  migration state; only the migrate role writes the ledger.
- **Graphile Worker**: its private tables carry row-level security with no
  policies (its model assumes the runtime owns the schema). Ownership stays
  with `cogeto_migrate` so the runtime cannot DDL the queue; row access is
  granted by an explicit policy instead.
- The demo reset keeps TRUNCATE on domain tables but now leaves `audit_log`
  and `deletion_receipt` in place: append-only holds even on the sandbox.

The property is proven by `infrastructure/least-privilege.integration.spec.ts`
against the real `db-init.sql` and the real migration path: the app role can
do its job (DML, audit INSERT, transactional enqueue) and cannot disable the
audit trigger, drop or truncate the receipt ledger, create schema objects,
write the migration ledger, or connect to the `zitadel` database.

### Scoped object storage and the public S3 surface

The app and worker authenticate to MinIO as a scoped user (`cogeto-app` by
default) provisioned by `minio-init`, whose policy is exactly the enumerated
application surface: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on
`cogeto/*`, and `s3:ListBucket`, `s3:GetBucketLocation`,
`s3:GetEncryptionConfiguration` on the bucket. Presigned download URLs are
signed with this same scoped credential, so a presigned link can never
authorize more than a bucket read. `minio-init` self-verifies both directions
at provision time: the scoped credential must list the bucket, and the MinIO
admin API must refuse it. The root credential exists only in `minio-init` and
the `minio` service itself.

On the production edge, the public `s3.<domain>` vhost serves exactly the one
thing the internet legitimately does there, a GET or HEAD on `/cogeto/*` (a
presigned download), and answers 403 to everything else, so `/minio/admin/*`
is no longer proxied to the internet. The dev stack keeps its
localhost-only consoles profile unchanged.

### Bootstrap PAT lifecycle

`zitadel-init` revokes the bootstrap machine PAT the moment provisioning
succeeds, verifies the token stopped authenticating, blanks `pat.txt`, and
records the provisioned inputs in `bootstrap-state.json`; later runs
short-circuit on that record instead of needing a live credential. On
customer installs the operator script additionally mints the PAT with a
14-day expiry as a backstop. Residuals, stated: the demo sandbox keeps its
PAT (the demo seed needs it, and a sandbox holds no real data), and changing
material provisioning inputs after install (for example the domain) requires
the operator to mint a fresh PAT, which the runbook documents.

## Residual notes

- **Same-org members are trusted with shared scope.** Shared means org-wide by
 design; there is no per-memory ACL beyond private/shared in v1.
- **A defense-in-depth follow-up is flagged, not done:** some writers omit
 `org_id` (their rows are NULL-org and reach the reader via the `IS NULL` arm).
 Under single-tenant this is the same one org; stamping `org_id` on every writer
 is the right step before any future where more than one org shares
 infrastructure when more than one org shares infrastructure.
- **Database traffic inside the compose network is plaintext, and that is
 accepted (audit 2.0 SEC-34).** Postgres runs with TLS off and the application,
 migration and Zitadel connections all reach it unencrypted. The accepted
 reasoning: Postgres publishes no port on either compose file, so the only
 listener is on the private bridge network; every party on that network (app,
 worker, migrate, Zitadel) already holds credentials to the database, so
 encrypting between them protects against an attacker who is already inside the
 network namespace, which is a position from which reading process memory or the
 `.env` file is easier than capturing traffic. The cost is a per-instance
 certificate to issue, mount, rotate and expire, on a single-tenant appliance the
 operator does not otherwise administer. This holds only while Postgres stays
 unpublished and single-host: **exposing the port, moving the database to another
 host, or putting a second tenant on the network each invalidate it**, and TLS
 becomes required at that point.

## Where this lives in the code

- Scope gate + owner-only mutations: `project/src/memory/` (store `visibleTo`,
 Qdrant `buildGateFilter`, aggregate methods)
- Identity seam (token validation, admin guard): `project/src/identity/`
- Audit reader: `project/src/entrypoints/` (`audit.integration.spec.ts`)
