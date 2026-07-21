# tasks — bounded context

Memory turned into action (scope §4.7): todos, reminders, follow-ups, the "open loops"
list, the daily digest, and meeting prep. Later hosts the dreaming-digest card (§B.6,
`[v1.x]`) — the nightly consolidation surfacing its work as a morning card.

Responsibilities: task/reminder records, digest assembly, scheduling of recurring
slow-path jobs (via the queue, §A.3 — jobs are idempotent, key
`(source_type, source_id, job_type)`).

Owns: task/reminder/digest tables, plus `task_conclusion` — the durable
provenance rows behind `source_type 'task_conclusion'` (decision 0037): when a
task concludes, the engine records a conclusion row and enqueues the normal
ingestion pipeline on it. That is the ONE way this module causes a memory to
exist; it never writes or transitions memory rows (`tasks_read_only_memory`).

May depend on: `memory` and `retrieval` public interfaces, `identity`. Consumes
domain events via the outbox; consequential outbound actions go through the
`agents` approval state machine (§A.8), never directly out.
