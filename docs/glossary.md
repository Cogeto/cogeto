# Cogeto — Glossary (the ubiquitous language)

Names in code, schema, APIs, prompts, and docs must match this glossary exactly —
same words, same spellings (Addendum and decision 0002 are the sources of truth;
on conflict, the Addendum wins and this file gets fixed). If a concept isn't here,
name it in a decision record before coining a term in code.

## Memory (core domain)

- **Memory** — one stored, extracted fact with full trust metadata: owner, scope,
  provenance, status, validity interval. The unit everything else operates on.
  Never a raw document or chunk. Code: `memory` table, `Memory` aggregate.
- **Fact** — the content of a memory (the claim itself). "Fact" and "memory" may
  be used interchangeably in prose; the stored entity is always a memory.
- **Memory aggregate** — the domain object owning memory invariants. Only
  reconciliation sets `contradicted`; only the user sets `user_approved`; only the
  deletion saga hard-deletes (Addendum §A.1 rule 4).
- **Owner** — the user a memory belongs to. Column: `owner_id` (NOT NULL).
- **Scope** — visibility class of a memory: `private` (owner only) or `shared`
  (others in the same organization). Column: `scope` (enum, NOT NULL). A hard gate
  in retrieval, never a score factor.
- **Status** — the memory lifecycle state. **Six lifecycle statuses plus an
  orthogonal `sensitive` boolean flag** (decision 0003, ruling 3). Schema and code
  enum labels: `active`, `outdated`, `contradicted`, `uncertain`, `replaced`,
  `user_approved` (underscore form — this is what migration 0001 and all identifiers
  use; the hyphenated "user-approved" appears only in prose and UI text). Column:
  `status` (enum, NOT NULL, default `active`). Statuses are score multipliers in
  retrieval; they never gate.
- **Sensitive** — an orthogonal flag, not a status: `sensitive BOOLEAN NOT NULL
  DEFAULT false` on `memory` (mirroring `file_metadata`). A hard gate in retrieval:
  sensitive memories are excluded from default retrieval, returned only to their
  owner, and only on explicit per-query opt-in (decision 0003).
- **Provenance / source link** — the reference from every memory back to what
  produced it. Columns: `source_type` + `source_id` (both NOT NULL — "the user told
  me directly" is provenance too: `user_note` | `chat`). Preferred term: **source
  link** in UI, **provenance** in engineering prose. Never "citation".
- **Validity interval** — event-time span during which a fact holds:
  `valid_from` / `valid_until`. Distinct from ingestion time (`created_at`).
- **Supersession** — a new fact replacing an old one: close the old interval, set
  the old memory `replaced`, point to the successor. Never destroys history.
- **Reconciliation** — the slow-path job that deduplicates, detects contradictions,
  maintains intervals, and updates statuses.
- **Time-travel memory** — point-in-time answers over validity intervals
  ("what did we previously decide?"); temporal queries lift the
  `outdated`/`replaced` exclusion.

## Ingestion & evaluation

- **Ingestion pipeline** — the fixed stage names, exactly six stages:
  **ingest → chunk → extract → verify → embed + store → reconcile**
  (Addendum §B.3, scope §4.9). "Embed + store" is one stage: each verified fact
  is embedded and persisted in the same step. Chunks are transient extraction
  inputs, never stored rows.
- **Verification pass** — the independent check ("does the cited source support
  this claim?") every extracted fact passes before counting as `active`;
  unsupported/partial → `uncertain` (§B.3).
- **Extract-and-discard** — privacy mode keeping derived memories while discarding
  the original file; per-upload flag with a per-user default (§A.9).
- **Prompt family / prompt version** — a named prompt purpose (extraction,
  verification, dedup, contradiction, consolidation) and its numbered, immutable,
  changelogged releases in `project/prompts/` (§B.7).
- **Golden set** — the hand-labeled corpus (per served language) with expected
  memories and retrievals; format in `docs/eval-golden-set.md`.
- **Eval harness** — the ingest → retrieve → judge pipeline scoring extraction,
  dedup, contradiction detection, and verification agreement against the golden
  set; a CI gate (§B.4).
- **Trust score** — the published per-release metrics from the eval harness.

## Retrieval

- **Hybrid retrieval** — semantic vectors (Qdrant) + keyword full-text (Postgres
  FTS) + entity match (trigram), fused with **reciprocal rank fusion (RRF)** (§A.5).
- **Hard gate** — a filter that excludes rows outright (`scope`, `sensitive`),
  applied as WHERE-clause / Qdrant payload pre-filters inside the query. Never a
  score penalty; app-side post-filtering is forbidden.
- **Status multiplier** — the per-status score factor applied after the gates
  (§A.5 table); `replaced` ×0 in default retrieval.
- **Reindex** — the command rebuilding Qdrant entirely from Postgres. Must always
  work; Qdrant is a rebuildable index, Postgres is the source of truth (§A.4).

## Architecture & runtime

- **Modular monolith** — one codebase; bounded contexts as internal modules; two
  deployable processes (§A.1).
- **Bounded context / module** — one directory under `project/src/`: `memory`,
  `ingestion`, `retrieval`, `agents`, `connectors`, `tasks`, `identity`,
  `model-gateway`. One public interface each; no module touches another's tables.
- **Seam** — a leaf module isolating an external dependency: **identity** (Zitadel)
  and **model-gateway** (Mistral). Seams import no domain module.
- **Entrypoint** — a composition root producing a deployable process: **app**
  (API, web, connectors, approval endpoints — fast path only) and **worker**
  (all slow-path jobs). Same image, different entrypoints (decision 0002).
- **Fast path / slow path** — synchronous retrieval + answering vs asynchronous
  background jobs. Slow-path work never runs in the request path (scope §6).
- **Outbox** — the Postgres table where domain events and job enqueues are written
  in the same transaction as the state change; the single cross-module mechanism
  (§A.3).
- **Job** — a unit of worker work. Idempotent, keyed by the **idempotency key**
  `(source_type, source_id, job_type)`; retries with backoff.
- **Dead-letter** — the table holding jobs that exhausted retries; visible in the
  dashboard.
- **Tenant** — one customer instance. In object keys and data, tenant = **Zitadel
  organization ID**, never a constant (§A.6).
- **Principal** — the authenticated user + organization + roles returned by the
  identity seam.

## Deletion & approval

- **Deletion saga** — the multi-step true-deletion flow: one Postgres transaction
  (memories + file metadata + receipt `pending` + outbox) → worker deletes Qdrant
  points and MinIO bytes → receipt `confirmed` → nightly sweep (§A.7).
- **Deletion receipt** — the signed, hash-chained record proving what was deleted;
  permanent, exportable, shown in the dashboard's **Forgotten** section (§B.1).
- **Consequential action** — anything that sends a message, deletes data, writes
  externally, or bulk-changes memory. Requires approval; executes only in the worker.
- **Approval state machine** — the server-side states, exactly:
  `draft → pending_approval → approved → executed`, plus `rejected`, `expired`
  (§A.8). Every transition is audit-logged.
- **Audit log** — the append-only record of approval transitions, status changes,
  and deletions.

## Product surfaces & features

- **Chat** — the primary conversational surface (fast path lives behind it).
- **Dashboard** — the governance surface: see/search/edit/correct/delete memories,
  statuses, source links, receipts, dead-letter jobs.
- **Connector** — a source integration; exactly three in v1: **notes**, **calendar**,
  **email** — built in that order (§A.11).
- **Task** — an actionable item derived from memory (person, topic, condition,
  status). Tasks read memory through its public interface; they never mutate it.
  Owned by the `tasks` context.
- **Open loops** — commitments and follow-ups without a recorded resolution.
- **Digest** — the daily summary produced by `tasks`.
- **Dreaming** — the nightly consolidation job; its surfaced summary is the
  **dreaming digest card** (§B.6, v1.x).
- **Redaction mode** — per-tenant toggle: local CPU NER pseudonymizes sensitive
  entities before any external model call, re-hydrates after (§B.8).
- **Memory Passport** — the full export (facts, statuses, provenance, history,
  receipts) in the published open format (§B.5, v1.x).
- **Ana sandbox** — the pre-populated demo persona seeded by compose
  `--profile demo` (§B.9).
