# 0015 — Approval state machine goes live (Session O1-B)

**Date:** 2026-07-07 · **Status:** accepted · **Governs:** the server-side
approval state machine (create → confirm → worker execution → expiry), the
action-type registry, the one wired consequential action (bulk memory outdate),
and the support columns that make the contractual table usable. **Driven by:**
Addendum §A.8 (approval gate), the glossary (*Approval state machine*), the
gap-audit finding that approvals were schema-only, the S1-B execution-guard
pattern, and the O1-B owner prompt. **Migration this session: 0015.**

The invariant above all others: **a consequential action executes ONLY from
server-side `approved` state, ONLY in the worker.** A front-end dialog is never
sufficient; the confirm endpoint flips state and does nothing else.

## Ruling 1 — Two additive support columns on `approval` (migration 0015)

The `approval` table + enum are contractual since migration 0001 and unchanged
in shape. Making the machine live needs two nullable/defaulted columns — no enum
change, no new semantics:

- `org_id text` — the tenant scope for confirm authorization (§A.4). A confirm
  or read from a different org is `NotFound` (existence must not leak). Derived
  at create from the requester's `principal.orgId`.
- `created_at timestamptz DEFAULT now()` — the "requested at" the Pending
  Approvals surface shows.

Plus `approval_status_idx` / `approval_org_status_idx` for the pending/history
queries and the expiry sweep. (Flagged for owner sign-off — it is a schema
addition to a contractual table, though additive and semantics-preserving.)

## Ruling 2 — The lifecycle and who may drive each edge

The pure `checkApprovalTransition` owns which edges exist:

```
draft → pending_approval        (submit)
pending_approval → approved | rejected | expired
approved → executed             (worker only)
rejected | expired | executed   — terminal
```

Who drives an edge is enforced by the caller: the **authenticated confirm
endpoint** (`POST /api/approvals/:id {decision}`) drives approve/reject and
writes `decided_by`/`decided_at`; the **scheduled pass** drives expiry; the
**worker executor** drives execution. So an `executed` record can never be
re-approved and a `rejected`/`expired` one can never execute — checked in the
machine AND re-checked in the executor (belt and suspenders).

## Ruling 3 — Execution is worker-only and idempotent (S1-B guard)

On approve, the confirm transaction enqueues an `approval.execute` job through
the outbox and **does nothing else**. The worker runs the effect inside the
S1-B execution guard (`idempotentTask` keyed `(approval, <id>, approval.execute)`),
so a duplicate delivery claims nothing and the effect runs at most once; the
executor also treats an already-`executed` row as a no-op and refuses any row
not in `approved`. The effect handler expresses only the effect — it acts as the
requesting user, reconstructed from the approval row (there is no request
principal at execution time).

## Ruling 4 — The action-type registry

`action_type → { Zod payload schema, initialStatus, ttlSeconds, summarize,
preview, authorizeCreate?, execute }`. The schema validates at every boundary;
`summarize`/`preview` render the Pending Approvals card server-side (the client
never needs an action's payload shape); `authorizeCreate` refuses a request the
caller may not make; `execute` is the worker-only effect. The registry is small
and open for O5's email-draft "send" action to register later.

## Ruling 5 — The wired action: bulk memory outdate

Chosen as primary because it is in-system, real, reversible (outdated → active),
and fully testable with no external dependency. Flow: a filtered Memories
selection → `create` a pending approval over explicit `memoryIds` (authorized:
every target must be the caller's own) → approve → the worker effect calls the
**Memory aggregate**, which owns the eligibility rules (§A.1 rule 4): it skips
`user_approved` (an explicit blessing is not overridden by a blanket action),
terminal `replaced`, and already-`outdated` rows, transitions the rest as the
user actor, and audits each. The receipt of the action is the executed
approval's result line ("Marked N outdated, skipped M").

## Ruling 6 — Expiry as a scheduled pass

An every-5-minute graphile cron (`approval_expiry` — underscore; the crontab
parser rejects dots) marks `pending_approval` rows past `expires_at` as
`expired`, one audit row each. Not `idempotentTask` (recurring, not one-shot);
idempotent by construction (a second pass finds none still pending-and-past).
Default TTL per action (24h for the bulk action).

## What O1-B did NOT change

The memory transition rules, the deletion saga, the receipt chain. The approval
surface is the ONLY new write path, and it drives no memory status itself except
through the Memory aggregate's existing transition function.
