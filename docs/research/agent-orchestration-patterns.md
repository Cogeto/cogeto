# Agent orchestration patterns

Distilled from studying a widely used agent-orchestration framework (durable graph
execution, human-in-the-loop) and a large multi-agent platform (approval guards,
work routing). Pattern → rationale → application; Cogeto mapping at the end.

## 1. Durable execution = persist state between every step

**Pattern:** Production agent runtimes persist a checkpoint of run state after each
step; a crashed or restarted process resumes from the last checkpoint, not from the
beginning. The persistence layer is a pluggable interface with a Postgres
implementation: a snapshot table (run id, step, state blob, parent pointer) plus a
pending-writes table for updates produced but not yet folded into a snapshot.

**Rationale:** Anything that can pause for a human **must** be persistent — an
approval can arrive hours later, after deploys and restarts. In-memory agent state
and "the run object lives in the web process" are disqualifying designs.

**Application:** Cogeto does not need a general graph runtime, but it needs exactly
this property for the approval flow: the *action row in Postgres is the checkpoint*.
Draft content, grounding context, and target are all columns/JSON on the
`agent_action` row — the run can always resume from the row alone.

## 2. Human-in-the-loop as a first-class pause, not a callback

**Pattern:** The mature mechanism for approval is an **interrupt**: execution reaches
a decision point, persists everything, and *stops holding any process resources*. The
pending decision is a queryable object (what is awaited, its payload/context, since
when). Resumption is a new invocation carrying the human's decision, which the
runtime routes to exactly the paused point. The studied multi-agent platform
implements the same idea as "guards": configurable checkpoints (on input, on output,
on dangerous tool use) that halt work pending an approval callback.

**Rationale:** Callback- or websocket-based approval couples the pause to a live
connection; interrupts survive disconnects and make pending approvals *listable* —
which is precisely what an approval inbox UI needs.

**Two costs to design around:**
- **Re-execution semantics:** the studied framework re-runs the interrupted step from
  its start upon resume — all code before the pause executes twice. Side effects
  before a pause must be idempotent or absent.
- **Decision provenance:** the resume payload (who approved, when, what exactly they
  saw) must be persisted, or the audit trail has a hole at its most important link.

**Application:** Cogeto's state machine (`draft → pending_approval → approved →
executed`, + `rejected`, `expired` — Addendum §A.8) is the interrupt pattern with the
graph machinery removed: the pause is a row in `pending_approval`; the "resume
invocation" is the authenticated confirm endpoint flipping it to `approved`; the
worker is the only executor. Design rule from the re-execution cost: **the confirm
endpoint only flips state; all side effects live in the worker's execution step**,
which is idempotent per action id.

## 3. Retries with backoff, per step, with full state intact

**Pattern:** Retry policy is declared per step (initial interval, backoff factor,
max attempts, which errors are retryable); a failed step retries with the same
persisted input state; exhausted retries park the run in an inspectable errored
state rather than vanishing.

**Application:** This is Cogeto's queue contract (§A.3) applied to agent execution:
approved actions are jobs; retryable errors (network, rate limits) back off;
non-retryable errors (target rejected the message) park the action in a dead-letter
state visible in the dashboard, still audit-logged. `expired` handles the human
never deciding; the dead-letter handles the world refusing the action.

## 4. Exactly-once is a lie; idempotent at-least-once is the contract

**Pattern:** Durable runtimes persist writes before advancing and replay them on
resume — giving at-least-once execution of any side-effecting step. Every studied
design converges on the same discipline: external effects must be idempotent
(idempotency keys on outbound calls), because a crash between "sent the email" and
"recorded that we sent it" *will* happen.

**Application:** Cogeto's idempotency key `(source_type, source_id, job_type)` (§A.3)
covers ingestion; agent execution adds per-action keys (action id as the idempotency
token on the outbound send). The deletion saga's receipt-confirmation step (§A.7) is
the same pattern: confirm only after downstream acknowledgment, sweep for orphans.

## 5. Observability: stream progress as typed events

**Pattern:** Runtimes expose execution as typed event streams (state-after-step,
step-started/finished with errors, token streams for model output) consumed by UIs
for progress display. The multi-agent platform routes all agent activity through a
timeline/trace log (timestamp, actor, input, output) that its dashboard renders.

**Application:** Cogeto v1 needs the modest version: every approval-state transition
and every job state change is an audit row; the dashboard reads those tables. Token
streaming applies only to chat drafting. No event-bus infrastructure — the audit
tables *are* the event log (and the outbox already gives ordered domain events).

## 6. Composition machinery a single-product system should refuse

The studied framework's power features — nested subgraphs with namespace-isolated
checkpoints, dynamic fan-out to parallel branches, channel reducers with
associativity requirements, time-travel replay across checkpoint history — solve
problems Cogeto v1 does not have. Costs they impose: schema bloat (per-channel
versioning), replay fragility (any nondeterminism corrupts resumption), and a
steep debugging curve. The multi-agent platform's inter-agent work-routing daemon
teaches the same lesson from the other side: separate orchestration infrastructure
pays off only past many concurrent autonomous workers.

**Application:** Cogeto's agent work is linear per action (draft → approve →
execute). A state-machine column plus the job queue covers it. Revisit orchestration
frameworks only if v-next introduces genuinely branching multi-step agent plans —
and even then, prefer extending the action table with a parent/plan id first.

## 7. The worker as sole executor (privilege separation)

**Pattern:** In both studied systems, the component that *decides* is separated from
the component that *acts*: the framework's interrupt decision comes from outside the
runtime; the platform's guards block inside the agent while execution resumes only
after external approval.

**Application:** Cogeto hardens this into privilege separation (§A.8): the app
process can create drafts and flip approval state (authenticated + audit-logged);
**only the worker executes**, and it executes only rows in `approved`. The app
process needs no credentials for outbound effects (SMTP, external APIs) — a
compromised web surface cannot send email. This is the security payoff of the
state-machine design, worth preserving through every refactor.

## Application to Cogeto — summary

| Pattern | Cogeto realization |
|---|---|
| Checkpoint = persisted run state | the `agent_action` row is the checkpoint |
| Interrupt = queryable, connection-free pause | `pending_approval` rows; approval inbox = a table scan |
| Resume routes the decision to the paused point | authenticated confirm endpoint → `approved`; worker picks up |
| Re-execution ⇒ pre-pause side effects forbidden | confirm endpoint flips state only; effects live in the worker |
| Per-step retry policy + parked errored state | queue retries/backoff + dead-letter visible in dashboard (§A.3) |
| At-least-once + idempotency keys | `(source_type, source_id, job_type)`; action id keys outbound sends |
| Typed progress events | audit rows on every transition; outbox as the event log |
| Refuse general graph machinery | linear state machine + queue; no subgraphs/reducers/replay |
| Decider/actor privilege separation | only the worker executes; app holds no outbound credentials |

One-line takeaway: an approval system is a durable-execution system with exactly one
interrupt point — build the persistence and idempotency discipline of an agent
runtime, and none of its graph machinery.
