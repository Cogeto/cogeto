# Agents propose, humans approve

Cogeto's agents never take a consequential action on their own. Any action with an
effect is proposed, held in a server-side approval state, and executed only after
an explicit human decision — and only in the background worker, never from a
front-end click. This document explains the state machine and the one invariant it
exists to guarantee.

## The invariant

> **A consequential action executes ONLY from server-side `approved` state, ONLY
> in the worker.**

A front-end dialog is never sufficient. The confirm endpoint flips server state
and does nothing else; the effect runs later, in the worker, reconstructed from
the stored approval. This means a compromised or buggy client cannot cause an
effect it was not authorized to, and an approval cannot be "clicked into" running
twice.

## The lifecycle

The permitted transitions (decision
[0015](../decisions/0015-approval-state-machine.md), ruling 2):

```
draft -> pending_approval            (submit)
pending_approval -> approved | rejected | expired
approved -> executed                 (worker only)
rejected | expired | executed        terminal
```

Who is allowed to drive each edge is enforced by the caller, not just the diagram:

- The **authenticated confirm endpoint** (`POST /api/approvals/:id {decision}`)
  drives approve/reject and records `decided_by` / `decided_at`.
- A **scheduled pass** drives expiry (pending rows past their TTL become
  `expired`, one audit row each).
- The **worker executor** drives execution.

So an `executed` record can never be re-approved, and a `rejected` or `expired`
one can never execute — checked in the pure transition function *and* re-checked
in the executor (belt and suspenders).

## Execution is worker-only and runs at most once

On approve, the confirm transaction enqueues an `approval.execute` job through the
outbox and does nothing else. The worker runs the effect inside an idempotency
guard keyed `(approval, <id>, approval.execute)`, so a duplicate delivery claims
nothing and the effect runs at most once. The executor also treats an
already-`executed` row as a no-op and refuses any row not in `approved`. The
effect acts **as the requesting user**, reconstructed from the approval row —
there is no ambient request principal at execution time.

## The action-type registry

Each action type registers a Zod payload schema, an initial status, a TTL, a
server-side `summarize`/`preview` (so the client never needs an action's payload
shape), an optional `authorizeCreate` guard (refuses a request the caller may not
make), and the worker-only `execute` effect. The schema validates at every
boundary. The registry is small and open for new actions to register.

The first wired action is **bulk memory outdate** — chosen because it is
in-system, real, reversible, and fully testable with no external dependency. Its
effect runs through the Memory aggregate, which owns the eligibility rules: it
skips explicitly user-approved memories, terminal `replaced` rows, and already
`outdated` ones, and audits each transition.

## How this composes with the rest

The approval surface is the **only** write path the state machine adds; it drives
no memory status itself except through the Memory aggregate's existing transition
function. Outward-facing agent actions (for example, an email-draft "send") are
expected to register as gated action types — the same invariant applies: the draft
is prepared, but nothing is sent until a human approves and the worker executes.
This is why a reply draft in Cogeto produces a copy-ready artifact and **sends
nothing** on its own.

## Where this lives in the code

- Transition function: `project/src/agents/domain/approval-machine.ts`
  (`checkApprovalTransition`)
- Action-type registry: `project/src/agents/action-types.ts`
- Confirm service + worker executor: `project/src/agents/approval.service.ts`,
  `project/src/agents/approval.executor.ts`
- Confirm endpoint: `POST /api/approvals/:id`
- Design: decision [0015](../decisions/0015-approval-state-machine.md) (Addendum
  §A.8, the approval gate)
