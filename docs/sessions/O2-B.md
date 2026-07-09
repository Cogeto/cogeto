# Session O2-B — Shared scope and the org second-user flow

**Model:** Opus 4.8. **Implements against (FROZEN):** `docs/handoff/F3-tasks.md`
§5 (shared tasks), AGENTS.md scope non-negotiables. **Decisions:**
`0019` (cross-org isolation = deployment boundary — owner-chosen),
`0020` (shared-scope surface rules). **Migrations:** `0018` (note.scope),
`0019` (app_user directory).

## The pivotal decision (owner-chosen)

The memory scope gate is `owner_id = caller OR scope = 'shared'` with **no org
predicate**, and memory rows carry **no org_id** — because the architecture is
**single-tenant**: one Zitadel org per instance (§A.6, business model, glossary).
I surfaced this and the owner chose **"deployment boundary, as designed"**: shared
= org-wide within the instance; cross-org isolation is separate deployments; no
org migration, no gate change. Recorded in decision 0019. Consequence for the
proof suite: same-org is proven exhaustively; row-level cross-org isolation for
*shared* rows is deployment-enforced, not row-tested (listed under "Unproven" —
private cross-org isolation IS proven, via the owner gate).

## Single-user assumptions found — and what I did

The app was already structurally multi-user (stateless Principals from token
claims; per-owner gates; lazy `user_settings`; owner-namespaced object keys;
per-principal digests; source-keyed idempotency). Concrete findings:

1. **Notes were private-only.** The embed-store stage hard-defaulted note-derived
   memories to `private` ("Notes are private in v1"), and capture had no scope.
   **Fixed:** `note.scope` column (migration 0018), threaded
   capture → note row → source reader → embed-store; capture now applies the
   Settings `defaultScope` when scope is omitted (it was upload-only — the
   Settings copy had over-promised "notes and uploads").
2. **No owner attribution / no user directory.** Identity was fully stateless, so
   a shared memory owned by another user could not be named. **Fixed:** an
   identity-owned `app_user` directory (migration 0019), recorded on each fresh
   token resolve ("provision on first login"); `UserDirectory.displayNames`
   resolves owner names locally — no Zitadel management API on the read path.
3. **Review showed peers' shared uncertain facts.** The uncertain queue was
   scope-gated (own + shared), but you cannot action a peer's fact. **Fixed:** a
   `mine` owner-filter on the memory list; the Review page and nav badge pass it.
4. **Audit `org_id` omission (documented, not changed).** Memory/reconciliation/
   tasks `writeAudit` calls omit `org_id`, so those rows are NULL-org and reach
   the reader via the `IS NULL` arm. Under single-tenant this is the *same one
   org*, so within the instance it is the intended org-wide trail — no cross-user
   leak beyond that, and **no memory content is ever in a detail field**
   (verified, and pinned by `audit_detail_carries_no_memory_content`). Stamping
   `org_id` on every writer is a defense-in-depth follow-up tied to any
   multi-org-on-shared-infra future (decision 0019/0020). **Not done — flagged.**
5. **Health / jobs / seeds:** no single-user assumption (health is infra-only;
   idempotency keys are source-keyed and collision-free; seeds are dev-CLI with
   explicit owner+org). No change needed.

## Conservative rules chosen (decision 0020)

- **Cross-owner contradictions are structurally impossible.** Reconciliation only
  compares a fact with the **same owner's, same-scope** memories
  (`reconcile.stage` `ownerOnly: true` + `row.ownerId !== fact.ownerId` guard), so
  every `memory_relation` is intra-owner and resolvable by exactly its one owner.
  A shared fact is *read* by peers but *reconciled* only within its owner. No code
  change — the guard already exists; documented + relied on.
- **Receipts are visible to the deletion's actor (the owner) only.** Deletion is
  owner-only (the saga rejects a non-owner of the source or any derived memory),
  and `GET /api/receipts` is scoped by `counts_json.requested_by`. A shared-memory
  deletion surfaces in the owner's Forgotten list, not org-wide. (Instance-wide
  integrity sweep still covers every receipt — operator integrity, not a user
  view.)

## What shipped (surfaces)

- **Scope selection:** capture (notes) + upload (files, already present) scope
  selectors, both prefilled from and defaulting to the Settings `defaultScope`;
  an **owner-only, audited change-scope action** (`POST /api/memories/:id/scope`
  → `MemoryStore.setScope`) that moves the row and the Qdrant payload's `scope`
  field together (shared→private demote hits vector search immediately).
- **Attribution:** `MemoryListItem` gains `ownerId` + `ownerName`; `ChatFactDto`
  gains `scope` + `ownerId` + `ownerName`. Memories list/drawer show a **shared**
  badge and "owned by <name>" for others' shared memory; chat citation chips
  attribute a shared fact to its owner. Names resolve through the directory.
- **Owner-only controls, UI:** the drawer hides approve/edit/mark-outdated/
  sensitive/change-scope/delete for a non-owner and explains why (the server
  enforces owner-only regardless — proven).
- **Tasks (F3 §5):** shared tasks are visible org-wide read-only (gated through
  the deriving memory); reopen/dismiss/complete stay owner-only. `task.scope`
  re-syncs to the memory's scope on the engine's next pass so a private→shared
  flip makes the task visible org-wide (shared→private hides it immediately via
  the memory gate).

## The cross-user proof suite

`project/src/retrieval/cross-user-scope.integration.spec.ts` (real Postgres +
Qdrant), two Principals in one org (A, B) + a third in another org (C). 10 tests,
all green:

- `private_invisible_to_org_peer` — B never sees A's private fact via get, list,
  **fts, entity, vector, point-in-time, changes-since** (chat retrieval context =
  these gated primitives; retrieval adds no ungated path).
- `shared_visible_to_org_peer` — reaches B on every read path, attributed to A.
- `sensitive_shared_stays_owner_only` — shared+sensitive never reaches B.
- `mutation_blocked_for_peer` — setScope/toggleSensitive/transition/editContent
  all 404 for B; A succeeds.
- `scope_change_propagates_to_reads_and_qdrant` — private→shared→private flips B's
  list AND vector visibility (payload moves with the row).
- `cross_org_private_isolated` — C never sees A's private fact.
- `tasks_shared_visible_read_only` — A's shared task visible to B; only A settles.
- `tasks_private_not_visible_to_peer`.
- `review_own_only` — a peer's shared uncertain is readable but NOT in B's Review.
- `audit_detail_carries_no_memory_content`.

### Unproven / not-row-tested surfaces (explicit)

- **Row-level cross-org isolation for SHARED memories** — enforced by
  single-tenant deployment (decision 0019), not a row gate; deliberately not
  asserted (would require the multi-tenant org gate the owner declined). Private
  cross-org isolation IS proven.
- **`org_id` on memory/task/reconciliation audit rows** — omitted (NULL-org);
  compliant under single-tenant, flagged as defense-in-depth follow-up.
- **End-to-end note→shared-memory through the live model pipeline** — the scope
  threading is proven by construction (capture → note.scope → source reader →
  embed-store `source.scope`) and unit-obvious; not re-proven through a live
  extraction (which needs the model).
