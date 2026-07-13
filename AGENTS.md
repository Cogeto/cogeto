# AGENTS.md — binding engineering rules

Non-negotiables for any agent working in this repository. Verify your work against
this checklist before finishing. Day-to-day workflow, doc map, and build order:
[`CLAUDE.md`](CLAUDE.md). Authority on all architecture questions:
`docs/Cogeto-v1-Addendum-Verifiable-Memory.md` (cited below as §A.x/§B.x) — it wins
over every other document.

## Data model (§A.6, §B.2)

- [ ] Every memory row carries `owner_id` (NOT NULL), `scope` enum
      (`private`|`shared`, NOT NULL), provenance `source_type` + `source_id`
      (NOT NULL — user-typed facts point at their message/note row; no orphans,
      ever), `status` enum of exactly **six lifecycle states** (`active`,
      `outdated`, `contradicted`, `uncertain`, `replaced`, `user_approved`;
      default `active`) **plus an orthogonal `sensitive` boolean flag**
      (NOT NULL DEFAULT false — decision 0003), and a validity interval
      (`valid_from`, `valid_until`).
- [ ] Status transitions are owned by the `Memory` aggregate: only reconciliation
      sets `contradicted`; only the user sets `user-approved`; only the deletion
      saga hard-deletes (§A.1 rule 4). Supersession closes intervals — it never
      destroys history (§B.2).
- [ ] Object keys: `tenant/user/scope/file-{uuid}`, first segment = Zitadel
      organization ID, never a constant (§A.6).

## Access & retrieval (§A.4, §A.5)

- [ ] **No query path returns memories without scope filtering.** Unscoped queries
      must be unrepresentable in the retrieval module's API.
- [ ] `scope` and the `sensitive` flag are **hard gates** — WHERE-clause / Qdrant
      payload pre-filters inside the vector query. App-side post-filtering of
      vector results is forbidden. A demoted leak is still a leak. Sensitive
      memories are excluded from default retrieval, returned only to their owner,
      and only on explicit per-query opt-in (decision 0003).
- [ ] Statuses are **score multipliers on top of the gates** (§A.5 table);
      `replaced` is excluded from default retrieval; temporal queries lift the
      `outdated`/`replaced` exclusion.
- [ ] **Postgres is the source of truth; Qdrant is a rebuildable index.** Nothing
      exists only in Qdrant; the `reindex` command (rebuild Qdrant from Postgres)
      must always work (§A.4).

## Seams (§A.10, scope §4.5/§5.1)

- [ ] All LLM and embedding calls go through the `model-gateway` interface. No
      direct provider SDK/API usage anywhere else.
- [ ] All identity/role lookups go through the `identity` interface. No direct
      Zitadel calls elsewhere. Zitadel asserts who/roles; memory scoping is
      Cogeto's own logic.

## Modules (§A.1)

- [ ] One public interface per module; internals private. **No module reads or
      writes another module's tables.** Cross-module communication is domain
      events via the Postgres outbox — one mechanism, not two.
- [ ] Nothing imports entrypoints; seams import no domain module.

## Async & jobs (§A.3, scope §6)

- [ ] **Slow-path work never runs in the request path**: extraction, dedup,
      contradiction checks, consolidation, reminders, deletion sagas, action
      execution are worker jobs. The fast path is retrieval + answering only.
- [ ] Enqueue is **transactional via the outbox** — nothing can be ingested and
      silently unprocessed.
- [ ] Jobs are **idempotent** with key `(source_type, source_id, job_type)`;
      retries with backoff; dead-letter table visible in the dashboard.

## Deletion (§A.7, §B.1)

- [ ] Deletion is the **saga**: one Postgres transaction (memory rows + file
      metadata + receipt row `pending` + outbox enqueue) → worker deletes Qdrant
      points and MinIO bytes with retries → receipt `confirmed` only after both
      acknowledge → nightly sweep verifies no orphans.
- [ ] The cascade has an automated test (bytes + metadata + memories + vectors +
      receipt) — a definition-of-done gate. Receipts are hash-chained and signed.

## Approval (§A.8)

- [ ] Consequential actions (send message, delete data, external write, bulk
      memory change) execute **only from server-side `approved` state**
      (`draft → pending_approval → approved → executed`, plus `rejected`,
      `expired`), created via an authenticated confirm endpoint. A front-end
      confirm dialog alone is non-compliant. Every transition is audit-logged.
- [ ] Only the worker executes; the confirm endpoint flips state and does nothing
      else; execution is idempotent per action id.

## Content (scope §4.9)

- [ ] **Facts, not raw documents, go into the vector store.** Chunks are transient
      extraction inputs, never stored rows. Originals live in MinIO; extracted
      facts in Postgres/Qdrant.
- [ ] Every extracted fact passes the independent verification pass before
      counting as `active`; unsupported/partial → `uncertain` (§B.3).

## Prompts & evaluation (§B.4, §B.7)

- [ ] Every prompt that decides what Cogeto remembers is a **versioned artifact**
      in `project/prompts/` — numbered, immutable once released, changelogged.
- [ ] Prompt or model changes are evaluated against the golden set; regressions
      fail the build. The eval harness is built alongside the extractor, not after.

## Confidentiality

- [ ] The studied reference projects informed `docs/research/` as patterns only.
      **Nothing in this repo may name or identify them** — no project names,
      package/import names, company/product names, authors, or URLs. Refer to them
      only by role (e.g. "a production memory layer"). This applies to code,
      comments, commit messages, and docs, permanently.

## Working rules

- [ ] **Never run git commands unless the owner explicitly asks.**
- [ ] **Commits and pull requests are always authored as the owner** — Ivan
      Golubic `<ivan@themrcto.com>`. Never a bot identity, never a
      `Co-authored-by` trailer. Issue/branch/PR operations go through `gh` as the
      owner. Delivery loop: `docs/engineering-workflow.md`.
- [ ] Application tests live under `project/src/`, next to the code they exercise (Vitest).
- [ ] New dependencies, frameworks, and Addendum deviations need owner sign-off
      (full list: CLAUDE.md).
- [ ] Read the matching `docs/research/` file before implementing memory,
      ingestion, retrieval, agents, or pipeline code.
- [ ] Notable decisions get a numbered record in `docs/decisions/`.
