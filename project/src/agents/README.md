# agents — bounded context

Human-approved agent execution. Owns the **server-side approval state machine**
(Addendum §A.8): consequential actions persist as rows moving through
`draft → pending_approval → approved → executed` (plus `rejected`, `expired`).
Execution happens **only in the worker**, reading `approved` rows created via an
authenticated confirm endpoint. A front-end confirm dialog alone is non-compliant.
Every transition is audit-logged.

Owns: approval/action tables and their audit log.

May depend on: `retrieval` and `memory` public interfaces (grounding), `model-gateway`
(drafting), `identity` (who approves). Emits/consumes domain events via the outbox (§A.3).

Read first: `docs/research/agent-orchestration-patterns.md`.
