# 0020 — Shared-scope behaviour across every surface (O2-B)

**Status:** Accepted. **Context:** O2-B makes shared scope real for a second
user. This record fixes the conservative rules chosen where the F3/handoff and
prompt asked for a judgment call, so later sessions do not re-litigate them.
Authority remains AGENTS.md's scope gates and [decision 0019](0019-cross-org-isolation-deployment-boundary.md).

## Rulings

1. **Reads are gated `own OR shared`; writes are owner-only — unchanged.** O2-B
   adds no gate logic. The store's `visibleTo` and Qdrant `buildGateFilter`
   already implement the hard gates; every mutating aggregate method
   (`transition`, `toggleSensitive`, the new `setScope`, `editContent`,
   `rejectUncertain`, the deletion saga) owner-checks via `lockRow` /
   enumeration and 404s a non-owner. The UI mirrors this (hidden controls +
   explanation) but the server is the authority.

2. **Scope change is owner-only, audited, two-store.** `POST
   /api/memories/:id/scope` → `MemoryStore.setScope` moves the row and the
   Qdrant payload's `scope` field together (the sensitive-toggle pattern), so a
   `shared → private` demote takes effect in vector search the instant it
   commits — a demoted leak is still a leak. Audited as `memory.scope_changed`.

3. **Cross-owner contradictions are structurally impossible → nothing to
   resolve across owners.** Reconciliation only ever compares a fact with the
   **same owner's, same-scope** memories (`reconcile.stage` passes
   `ownerOnly: true` and drops any candidate where `row.ownerId !== fact.ownerId
   || row.scope !== fact.scope`). So every `memory_relation` is intra-owner, and
   `resolveContradiction`'s "caller owns both sides" guard is always satisfiable
   by exactly one user — its owner. A shared fact is *read* by peers but
   *reconciled* only within its owner's memory. This is the conservative rule the
   handoff asked for; it needs no new code, only this record and a pinning test.

4. **Review is own-only.** A user reviews their own `uncertain` extractions and
   their own contradictions — never a peer's shared `uncertain` fact (which they
   could see but not action). Implemented with a `mine` owner-filter on the
   memory list; the Review page and the nav badge pass it. (Contradictions were
   already own-only per ruling 3.)

5. **Receipts are visible to the deletion's actor (the owner).** Deletion is
   owner-only (the saga rejects a caller who does not own the source and every
   derived memory), and `GET /api/receipts` is scoped by
   `counts_json.requested_by = caller`. So a shared-memory deletion surfaces in
   the **owner's** Forgotten list only, not org-wide. Conservative choice: the
   act of forgetting is private to the person who performed it; the org is not
   notified. (Instance-wide integrity — the sweep and `/verify` — still covers
   every receipt; that is operator integrity, not a per-user view.)

6. **Audit is the org-wide trail; it carries no memory content.** `GET
   /api/audit` is org-scoped (`org_id = caller OR org_id IS NULL`) and read-only.
   No `writeAudit` detail field contains memory or note **content** — only ids,
   statuses, reasons, counts (verified in O2-B). Within the single org, members
   share one org, so the org-wide trail legitimately shows all members' actions
   (ids/actions, never content). **Follow-up (not done, flagged):** the
   memory/reconciliation/tasks writers omit `org_id`, so their rows are NULL-org
   and reach the reader via the `IS NULL` arm; under single-tenant this is the
   same one org, but stamping `org_id` on every writer is the right
   defense-in-depth step before any multi-org-on-shared-infra future (ties to
   0019).

## Consequences

- `MemoryListItem` and `ChatFactDto` gain `ownerId` + `ownerName` (and the chat
  DTO gains `scope`); names resolve through the identity **user directory**
  (`app_user`, migration 0019) — recorded on first login, name-only, never a
  visibility grant. Notes gain a capture-time `scope` (migration 0018) so shared
  notes are possible; the Settings default now governs capture as well as upload.
- Derived tasks inherit the memory's scope and re-sync it on the engine's next
  pass, so a `private → shared` flip makes the task visible org-wide (no-leak on
  `shared → private` is immediate — task visibility is gated through the deriving
  memory's readability).
