# 0019 — Cross-org isolation is a deployment boundary (O2-B)

**Status:** Accepted (owner decision, O2-B). **Context:** enabling a second user
and shared scope raised the question of how Cogeto isolates one organization's
memory from another's. The memory scope gate is `owner_id = caller OR scope =
'shared'` — it has **no org predicate**, and memory rows carry **no org_id**.

## Decision

Cogeto is **single-tenant**: one Zitadel organization per instance, on its own
Postgres / Qdrant / MinIO / Zitadel org (Addendum §A.6 "tenant = Zitadel
organization ID"; business model §A "a dedicated, isolated instance per
customer"; glossary "Tenant = one customer instance"). Therefore:

1. **Shared scope means org-wide within the instance.** Every authenticated user
   belongs to the instance's single org, so `scope = 'shared'` is exactly
   "visible to the organization" (glossary "Scope").
2. **Cross-org isolation is enforced by deployment, not by a row gate.** Two orgs
   never share a database, so there is no query in which one org could observe
   another's rows. Adding an `org_id` column and an org predicate to the gate
   would be redundant under single-tenant and is explicitly the kind of
   gold-plating §A.6 warns against. It is **not** added in v1.
3. **The owner was asked and chose this** ("deployment boundary, as designed")
   over adding a defense-in-depth org gate. Introducing multi-tenant row gating
   is a Part-A data-model change and would need a fresh owner decision.

## Consequences

- The cross-user proof suite proves the **same-org** contract exhaustively
  (private isolated by owner; shared visible to peers; mutations owner-only;
  sensitive owner-only; scope changes propagate). A "third user in another org"
  is modeled by a Principal with a different `orgId`, but **row-level cross-org
  isolation is not a gate assertion** — it is the deployment boundary. The proof
  suite documents this explicitly rather than asserting a gate that does not
  exist. (See O2-B session log, "unproven surfaces".)
- **Forward-compat, if consolidation is ever pursued** (§A.6 anticipates "small
  tenants consolidated onto shared infrastructure"): before more than one org
  shares a database, an `org_id` column + gate predicate + Qdrant payload field
  + audit `org_id` stamping on every writer become load-bearing. That migration
  is the deliberate trigger for revisiting this decision. Until then, the object
  key's org segment and the per-instance deployment are the isolation.
