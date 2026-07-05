# CLAUDE.md — how to work in this repo

Cogeto: a private, EU-hosted AI command center that turns scattered work context
(email, calendar, notes, documents) into **verifiable memory** — every trust claim
backed by an inspectable artifact — with human-approved agents on top.

**The binding engineering rules live in [`AGENTS.md`](AGENTS.md). Read them first.**

## Doc map — what to read, when

| Doc | Read it when |
|---|---|
| `docs/Cogeto-v1-Addendum-Verifiable-Memory.md` | **Always, first.** Binding architecture decisions (Part A) + feature set with v1/v1.x/Later tags (Part B). Wins over every other doc on conflict. |
| `docs/Cogeto-v1-scope.md` | For product scope, users, positioning, business model. |
| `docs/Cogeto-v1-Specification.docx` | Full product spec (binary; owner-maintained). |
| `docs/Cogeto-Technical-Architecture.md` | Full engineering plan: stack rationale, containers, mechanisms, phased implementation. (The .docx is the presentation copy.) |
| `docs/glossary.md` | The ubiquitous language — names in code must match it. |
| `docs/eval-golden-set.md` | Corpus format, metrics, CI gates for the eval harness. Read before building the extractor or harness. |
| `docs/research/*.md` | **Required before implementing the matching area** — see the table in `docs/research/README.md`. Distilled patterns from studied production systems. |
| `docs/decisions/` | Numbered decision records — 0001 (repo structure) and 0002 (technology stack) exist and are **binding**. Read before structural changes; add one for every notable decision (structure, stack, renames, dependencies). |
| `project/README.md` + per-directory READMEs | Orientation: each states what lives there, allowed dependencies, and the governing Addendum section. |

## Repo shape (one line each)

- `project/src/` — modular monolith: one directory per bounded context; two
  entrypoints (app, worker). Module rules: `project/src/README.md` (Addendum §A.1).
- `project/web/` — chat + dashboard frontend. `project/prompts/` — versioned prompt
  artifacts (§B.7). `project/infra/` — compose stack; `docker compose up` is the
  contract (§A.2).
- `docs/` — specs, research, decisions. Application tests live under `project/src/`,
  next to the code they exercise (Vitest).
- `assets/brand/` — canonical logo files (trademarked, not AGPL — see TRADEMARK.md).
  Reuse from here; never generate, recreate, or modify the logo.

## Status and what to do first

Scaffolding is complete; **the next session is the first coding session.**

Stack is decided and binding: see `docs/decisions/0002-technology-stack.md`
(TypeScript/Node 22, NestJS, Drizzle + PostgreSQL 17, Graphile Worker, Qdrant,
MinIO, Zitadel, Caddy, React + Vite). Do not re-open it.

The very first coding task is scaffolding the NestJS + Vite workspace per 0002.
Then, in order:

1. **Migration 0001** per Addendum §A.6 (memory, file_metadata; NOT NULL provenance,
   scope enum, 7-state status, validity intervals) — as a one-shot init container
   (§A.2).
2. **Outbox + job queue** (§A.3) with idempotency keys and dead-letter table.
3. **Notes vertical slice** (§A.11): ingest → extract → verify → embed → reconcile →
   retrieve → dashboard → deletion cascade, with the eval harness built alongside
   the extractor (§B.4).

## Coding conventions

TypeScript strict mode. ESLint + Prettier. dependency-cruiser enforces the module
map in CI (§A.1). Zod at every boundary. pino for logging — never memory content or
tokens in logs. Tests: Vitest (unit), Testcontainers (integration), Playwright (e2e).
Vocabulary per `docs/glossary.md` — names in code must match it.

## Definition of done (any coding change)

- `docker compose up` still reaches login on a fresh clone (§A.2).
- CI module-boundary checks pass (§A.1); no cross-module table access.
- The binding invariant tests pass once they exist: scope-leak, deletion-cascade
  (§A.7), approval-gate (§A.8), golden-set eval gate (§B.4 — prompt/model changes
  that regress it fail the build).
- Docs updated in the same change when behavior contradicts them; notable decisions
  get a `docs/decisions/` record.

## Needs owner sign-off (ask first)

- Any new dependency, framework, or the stack choice itself.
- Any deviation from an Addendum Part A decision or §A.6 schema commitment.
- The Gmail/CASA path (§A.11) — owner decision, gates launch.
- Git: **never run git commands unless explicitly asked** — the owner manages git.
- Anything user-visible leaving the machine (publishing, external calls with real data).
