# AGENTS.md: binding engineering rules

Non-negotiables for anyone working in this repository. Verify your work against this
checklist before finishing. Day-to-day workflow and the doc map are in
[`CLAUDE.md`](CLAUDE.md).

**Authority.** [`docs/cogeto-specification.md`](docs/cogeto-specification.md) is the
normative rulebook: MUST marks a rule whose violation is a defect. It wins over every
other document, and the section numbers cited below are its.
[`docs/cogeto-v2-plan.md`](docs/cogeto-v2-plan.md) is binding for what gets built in the
current cycle, and
[`docs/cogeto-technical-architecture.md`](docs/cogeto-technical-architecture.md)
describes the shape it is built in.

## Data model (spec §1, §3, §6)

- [ ] Every memory row carries `owner_id` (NOT NULL), `scope` enum
      (`private`|`shared`, NOT NULL), provenance `source_type` + `source_id`
      (NOT NULL: user-typed facts point at their message or note row; no orphans,
      ever), and a validity interval (`valid_from`, `valid_until`).
- [ ] `status` is an enum of exactly these **six** lifecycle values: `active`,
      `outdated`, `contradicted`, `uncertain`, `replaced`, `user_approved`
      (default `active`). `sensitive` is an **orthogonal** boolean beside it
      (NOT NULL DEFAULT false), never a seventh status: a sensitive fact can also
      become outdated.
- [ ] Status transitions are owned by the `Memory` aggregate: only reconciliation
      sets `contradicted`; only the user sets `user_approved`; only the deletion
      saga hard-deletes, with the single audited exception of review rejection.
      Supersession closes intervals; it never destroys history (spec §3.6, §6.2). Editing a
      memory's content **is** supersession, never mutation.
- [ ] Object keys: `tenant/user/scope/file-{uuid}`, first segment = Zitadel
      organization ID, never a constant.
- [ ] A **defunct** `source_type` value is a *known* value, never an unexpected one.
      No switch may throw on it and no sweep arm may flag it as unrecognised.

## Access and retrieval (spec §4, §7)

- [ ] **No query path returns memories without scope filtering.** Unscoped queries
      must be unrepresentable in the retrieval module's API.
- [ ] `scope` and `sensitive` are **hard gates**: WHERE-clause and Qdrant payload
      pre-filters inside the vector query. App-side post-filtering of vector results
      is forbidden. A demoted leak is still a leak. Sensitive memories are excluded
      from default retrieval, returned only to their owner, and only on explicit
      per-query opt-in.
- [ ] Statuses are **score multipliers on top of the gates** (spec §3.4); `replaced` is
      excluded from default retrieval; temporal queries lift the `outdated` and
      `replaced` exclusion but **never** weaken a hard gate.
- [ ] The interval predicate exists **once** (`memory/domain/interval.ts`), as a SQL
      fragment and a pure TypeScript twin tested against each other. No query, view,
      or answer-side check may hand-roll it.
- [ ] **Postgres is the source of truth; Qdrant is a rebuildable index.** Nothing
      exists only in Qdrant; `reindex` must always work.

## Seams (spec §12)

- [ ] All LLM and embedding calls go through the `model-gateway` interface. No direct
      provider SDK or endpoint usage anywhere else. Call sites request a **tier**,
      never a model string.
- [ ] All identity and role lookups go through the `identity` interface. No direct
      Zitadel calls elsewhere. Zitadel asserts who and which roles; memory scoping is
      Cogeto's own logic.
- [ ] Only `entrypoints` reads the environment.

## Modules (spec §15)

- [ ] One public interface per module; internals private. **No module reads or writes
      another module's tables.** Cross-module communication is domain events via the
      Postgres outbox: one mechanism, not two.
- [ ] Nothing imports entrypoints; seams import no domain module.
- [ ] Where a dependency must run against the graph direction, it is a **port**
      defined by the owning module and implemented by the caller, bound at the
      composition root.

## Async and jobs (spec §15.4)

- [ ] **Slow-path work never runs in the request path**: extraction, dedup,
      contradiction checks, consolidation, deletion sagas, action execution, skill
      runs and passport exports are worker jobs. The fast path is retrieval and
      answering only. The one sanctioned enqueue on the chat fast path is the
      conversation auto-title job.
- [ ] Enqueue is **transactional via the outbox**: nothing can be ingested and
      silently unprocessed.
- [ ] Jobs are **idempotent** with key `(source_type, source_id, job_type)`; retries
      with backoff; dead-letter table visible in the dashboard. Recurring passes
      (sweep, dreaming) are the sanctioned exception to the wrapper and must be
      idempotent by construction instead.

## Deletion (spec §11)

- [ ] Deletion is the **saga**: one Postgres transaction (memory rows + file metadata
      + receipt row `pending` + outbox enqueue) → worker deletes Qdrant points and
      MinIO bytes with retries → receipt `confirmed` only after both acknowledge →
      nightly sweep verifies no orphans.
- [ ] **A receipt can never read `confirmed` while an enumerated identifier could
      still exist.**
- [ ] The cascade has an automated test (bytes + metadata + memories + vectors +
      receipt): a definition-of-done gate. Receipts are hash-chained and signed, and
      **linkage defines chain order, never timestamps**.
- [ ] The sweep **detects; it never repairs.** An identifier that reappeared after a
      signed promise means a human must find out how, and an automated fix would
      destroy the evidence.
- [ ] Never change the receipt canonicalization or chain verification. A byte of
      difference invalidates every historical receipt on every instance.

## Approval

- [ ] Consequential actions (send message, delete data, external write, bulk memory
      change) execute **only from server-side `approved` state**
      (`draft → pending_approval → approved → executed`, plus `rejected`, `expired`),
      created via an authenticated confirm endpoint. A front-end confirm dialog alone
      is non-compliant. Every transition is audit-logged.
- [ ] Only the worker executes; the confirm endpoint flips state and does nothing
      else; execution is idempotent per action id.

## Content and privacy

- [ ] **Facts, not raw documents, go into the vector store.** Chunks are transient
      extraction inputs, never stored rows. Originals live in MinIO; extracted facts
      in Postgres and Qdrant.
- [ ] Every extracted fact passes the independent verification pass before counting
      as `active`; unsupported or partial becomes `uncertain` (spec §2.3).
- [ ] **No content in `audit_log.detail_json`, ever.** Ids, kinds, transition names,
      counts, booleans. Never memory, note, or chat content, and never model free
      text. Explanations live on the owner-gated domain row they serve.
- [ ] Never log memory content or tokens.
- [ ] Extraction **fabricates nothing**. A parse or model failure produces zero
      memories, never an invented one.

## User-visible copy (V2.0 item 3.5)

- [ ] **No user-visible literal ever goes into a component.** Every string a user
      reads is a key resolved through `t()`, in the namespace of the surface it
      belongs to. This covers headings, labels, buttons, placeholders, tooltips,
      empty states, loading text, error and validation copy, confirmation dialogs
      including their consequence text, chart labels, badge and status labels,
      aria-labels, and document titles. Log lines, developer errors, test
      fixtures and prompt assembly are NOT copy and stay where they are.
- [ ] **A feature is not finished until its keys exist in EVERY locale.** Adding
      copy means adding it to `en` (the source of truth) and to every other
      locale, where the English text is a legitimate value for an untranslated
      language. `npm run i18n:check` runs inside `lint` and fails the build on a
      missing, orphaned or unused key; a new namespace must be created in every
      locale and registered in `project/web/src/i18n/namespaces.ts`.
- [ ] **Keys are structural, never named after their English content.**
      `sources.detail.emptyState.title`, so rewording English never invalidates a
      translation.
- [ ] **Enum values are never translated**, only their display names, through an
      explicit value → key map. A translated label never travels to an API.
- [ ] **One sentence is one key.** Named interpolation (`{{count}}`), never
      positional; plurals through the CLDR suffix keys, never manual
      concatenation; markup inside a sentence is a `<tag>` slot filled by
      `<Trans>`, never a fragment joined at the call site.
- [ ] **Nothing formats a date, time, number or file size by hand.** They go
      through the shared locale-aware helper, so a user's interface language, not
      their browser, decides. Full rules and the translator workflow:
      [`docs/features/i18n.md`](docs/features/i18n.md).

## Prompts and evaluation (spec §12.3, §14)

- [ ] Every prompt that decides what Cogeto remembers is a **versioned artifact** in
      `project/prompts/`: numbered, immutable once released, changelogged.
- [ ] Prompt or model changes are evaluated against the golden set; regressions fail
      the build. The eval harness is built alongside the extractor, not after.
- [ ] **Gates ratchet up, never down.** Lowering one must be justified in the pull
      request that does it, with the measurement that justifies it.
- [ ] Structured extraction runs at `temperature: 0`. What Cogeto remembers must not
      depend on a sampling dice roll.
- [ ] Nothing hides a dip. Published metrics include the unflattering ones.

## Confidentiality

- [ ] The studied reference projects informed `docs/research/` as patterns only.
      **Nothing in this repo may name or identify them**: no project names, package
      or import names, company or product names, authors, or URLs. Refer to them only
      by role (e.g. "a production memory layer"). This applies to code, comments,
      commit messages, and docs, permanently.

## Working rules

- [ ] **Never run git commands unless the owner explicitly asks.**
- [ ] **Commits and pull requests are always authored as the owner**, Ivan Golubic
      `<ivan@themrcto.com>`. Never a bot identity, never a `Co-authored-by` trailer,
      never an AI-authorship or "generated with" line in any git artifact. Issue,
      branch, and pull-request operations go through `gh` as the owner. Delivery
      loop: [`docs/engineering-workflow.md`](docs/engineering-workflow.md).
- [ ] Application tests live under `project/src/`, next to the code they exercise
      (Vitest).
- [ ] New dependencies, frameworks, and the specification deviations need owner sign-off
      (full list in `CLAUDE.md`).
- [ ] Read the matching [`docs/research/`](docs/research/) file before implementing
      memory, ingestion, retrieval, agents, or pipeline code.
- [ ] **The decision trail is the issue and the pull request.** State what changed and
      why in the PR body, and update the affected documentation in the same change.
