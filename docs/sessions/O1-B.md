# Session O1-B — The approval state machine (Addendum §A.8)

**Model:** Opus 4.8. **Implements against:** Addendum §A.8, the glossary
(*Approval state machine*), the gap-audit finding that approvals were
schema-only, and the S1-B execution-guard pattern. **Decision:**
`docs/decisions/0015-approval-state-machine.md`. **Migration:** 0015 (two
additive support columns on the contractual `approval` table).

The core invariant made real: **a consequential action executes ONLY from
server-side `approved` state, ONLY in the worker — a front-end dialog is never
sufficient.**

## What shipped

1. **The state machine (agents).** `checkApprovalTransition` (pure edges:
   draft→pending_approval→approved→executed, +rejected/expired, terminals
   enforced). `ApprovalService`: `create` (registry-validated + authorized),
   `confirm` (approve|reject — the only path; writes decided_by/at + audit; on
   approve enqueues the worker job through the outbox and does nothing else),
   `expireStale` (the scheduled pass), and org-scoped `listPending`/`listHistory`/
   `get`. `ApprovalExecutor` (worker-only, guarded, idempotent). Illegal
   transitions return typed errors.
2. **Action-type registry** — `action_type → { Zod schema, initialStatus,
   ttlSeconds, summarize, preview, authorizeCreate?, execute }`. Small and open;
   summary/preview render the pending card server-side.
3. **One real action, end-to-end** — bulk memory outdate. A filtered Memories
   selection → a pending approval over the caller's own `memoryIds` → approve →
   the worker effect calls the **Memory aggregate**, which skips `user_approved`,
   terminal, and already-outdated rows, transitions the rest, and audits each.
   Reversible (outdated → active).
4. **Pending Approvals surface** — a nav item with a live count badge, Pending +
   History tabs, each card showing the action type, human summary, payload
   preview, requester, and requested/expiry times, with Approve/Reject calling
   the confirm endpoint. History is read-only with the executed result. The
   Memories list gained a **Select** mode → "Request 'Mark outdated' approval"
   (it creates a pending approval, never an instant edit).
5. **Worker wiring** — `approval.execute` (guarded) + `approval_expiry` (every-5-min
   cron) registered; both roots resolve the service/executor.

## Test results (full battery)

- **build / lint / boundaries**: green (234 modules).
- **Vitest**: **126 passed, 1 skipped** (+10 this session; run
  `--no-file-parallelism` — a fully parallel run can flake on Testcontainers
  startup contention, not a code issue). New:
  - `agents/approvals.integration.spec.ts` (real Postgres): `bulk_action_effect`
    (changes exactly the eligible targets, skips `user_approved`, reversible),
    `approval_worker_only` (confirm transitions state but runs no effect; only
    the worker executes), `approval_execute_only_from_approved` (execution from
    pending/rejected/expired impossible via API and worker; executed can't be
    re-approved), `approval_idempotent` (duplicate delivery runs the effect once —
    the S1-B guard skips it), `approval_expiry` (expired cannot execute; second
    pass is a no-op), `approval_authz` (a foreign org cannot see, confirm, or
    target this org's approvals), `approval_audited` (created/approved/executed/
    rejected/expired each write exactly one audit row).
  - `agents/domain/approval-machine.spec.ts` — the pure edge table.
- **`docker compose up` reaches login**: migration 0015 applied; app + worker +
  caddy rebuilt and healthy; `ApprovalsController` routes mapped; worker
  registered `approval.execute` + `approval_expiry`; `/login` 200.

## Live end-to-end drill (compose stack, real OIDC login)

Captured two throwaway notes → their derived memories, then over HTTPS:

- `POST /api/approvals {memory.bulk_outdate, {memoryIds:[2]}}` → **201**,
  `pending_approval`, summary "Mark 2 memories outdated"; pending list count 1.
- `POST /api/approvals/:id {decision:approve}` → **approved**.
- Immediately after approve → memories **still `active`** (the app ran no
  effect — worker-only).
- After the worker → **2 of 2 `outdated`**; history entry **`executed · Marked 2
  outdated`**.
- `POST /api/approvals/:id {decision:reject}` (a second approval) → **rejected**,
  no memory change.
- Cleaned up (deleted the note sources; instance left with 0 pending approvals).

## Owner checklist (sign-off / decisions)

- [ ] **Migration 0015** adds `org_id` + `created_at` (and two indexes) to the
      contractual `approval` table — additive and semantics-preserving, but a
      schema change to confirm. Rationale: org scoping for confirm authz (§A.4)
      and the "requested at" display. (0015 ruling 1.)
- [ ] **Org authorization** uses `org_id` derived from the requester's principal
      at create; a foreign-org confirm/read is 404. Multi-user-within-org
      approve (someone other than the requester approving) is allowed by design
      (that is the point of an approval gate); refine per-role in O2 if desired.
- [ ] **The wired action is in-system** (bulk memory outdate). The external
      "send" action is intentionally deferred to O5 (email drafts) — the
      registry is ready for it.
- [ ] Two drill approval rows (1 executed, 1 rejected) remain in History as the
      genuine trail; approvals have no delete path by design (audit record).
- [ ] Numbering: decision **0015**, migration **0015** taken this session.

## STOP

O1-B complete. The approval gate is live and enforced (worker-only, guarded,
org-scoped, audited). Remaining O1 items for a later session: audit-log
reader/UI panel, extract-and-discard mode, minimal Settings.
