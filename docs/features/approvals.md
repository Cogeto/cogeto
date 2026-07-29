# Approvals: the gate consequential actions pass through

The invariant above all others: **a consequential action executes only from
server-side `approved` state, and only in the worker.** A front-end confirm dialog is
never sufficient. The confirm endpoint flips state and does nothing else.

Because this machine and the audit log existed before there was anything to govern,
agentic features could be added later without retrofitting governance.

## The lifecycle

```
draft → pending_approval
pending_approval → approved | rejected | expired
approved → executed          (worker only)
rejected | expired | executed   terminal
```

A pure transition function owns which edges exist. **Who** may drive an edge is
enforced by the caller:

- the authenticated **confirm endpoint** drives approve and reject, writing who
  decided and when;
- the **scheduled pass** drives expiry;
- the **worker executor** drives execution.

So an `executed` record can never be re-approved and a `rejected` or `expired` one can
never execute. Both the machine and the executor check, deliberately redundantly.

Every transition is audit-logged. Reads and confirms are org-scoped, and a mismatch is
NotFound so existence does not leak.

## Execution

On approve, the confirm transaction enqueues the execution job through the outbox and
does nothing else. The worker runs the effect inside the execution guard, keyed on the
approval, so a duplicate delivery claims nothing and the effect runs **at most once**.
The executor also treats an already-executed row as a no-op and refuses any row not in
`approved`.

The effect acts as the requesting user, reconstructed from the approval row, because
there is no request principal at execution time.

## The action registry

Each action type declares a Zod payload schema, an initial status, a TTL, a
`summarize` and `preview` pair, an optional create-time authorization check, and the
worker-only `execute`.

The schema validates at every boundary. `summarize` and `preview` render the pending
card **server-side**, so the client never needs to know an action's payload shape.

**The wired action is bulk memory outdate**, chosen because it is in-system, real,
reversible, and fully testable with no external dependency. The flow ends at the
`Memory` aggregate, which owns the eligibility rules: it skips `user_approved` rows
(an explicit blessing is not overridden by a blanket action), terminal `replaced`
rows, and rows already outdated, transitions the rest as the user actor, and audits
each. The receipt of the action is the executed approval's result line.

Expiry is a five-minute scheduled pass marking overdue pending rows `expired`, one
audit row each. It is idempotent by construction, since a second pass finds none still
pending and past.

## What approvals deliberately do not cover

**Research queries.** A query changes nothing; it discloses. The approval machine's
execution leg is worker-async by design, which is right for consequential side effects
and wrong for an interactive search the user is waiting on. Research uses its own run
record, which keeps the same honesty properties in a synchronous shape: server-side
state the effect is impossible without, explicit user action, audited transitions,
owner-only access. See [`web-research.md`](web-research.md).

**Skill steps.** The skill runtime adds no second executor. Any future skill action
that writes outside the instance routes through this machine.
