# CLAUDE.md: how to work in this repo

Cogeto: a private, EU-hosted AI command center that turns scattered work context
(email, notes, documents, the web) into **verifiable memory**, every trust claim
backed by an inspectable artifact, with human-approved agents on top.

**The binding engineering rules live in [`AGENTS.md`](AGENTS.md). Read them first.**

## Doc map

| Doc | Read it when |
|---|---|
| [`docs/Cogeto-V2-Plan.md`](docs/Cogeto-V2-Plan.md) | **Before any 2.0 work. BINDING.** The complete 2.0 plan, version by version, with priority and difficulty. |
| [`docs/Cogeto-v1-Addendum-Verifiable-Memory.md`](docs/Cogeto-v1-Addendum-Verifiable-Memory.md) | **The architecture authority.** Binding decisions (Part A) plus the feature set (Part B). Wins over every other doc on an architecture question. Cited everywhere as §A.x / §B.x. |
| [`docs/architecture.md`](docs/architecture.md) | Stack rationale, the two processes, the module map, the pipeline, the seams, local infrastructure. |
| [`docs/features/`](docs/features/) | How a feature actually behaves and why. Start here before changing one. |
| [`docs/security/`](docs/security/) | **Single entry point for security and safety**: how the protections work, how to verify them, and the co-located tests. |
| [`docs/engineering-workflow.md`](docs/engineering-workflow.md) | **Before opening any issue, branch, or PR.** The delivery loop, Conventional Commits, required checks, tag-driven releases. |
| [`docs/glossary.md`](docs/glossary.md) | The ubiquitous language. Names in code must match it. |
| [`docs/eval-golden-set.md`](docs/eval-golden-set.md) | Corpus format, metrics, CI gates. Read before touching the extractor, a prompt, or the harness. |
| [`docs/research/*.md`](docs/research/) | **Required before implementing the matching area.** See the table in `docs/research/README.md`. |
| [`docs/Cogeto-v1-scope.md`](docs/Cogeto-v1-scope.md) | Product scope, users, positioning, business model. |
| `docs/Cogeto-v1-Specification.docx` | Full product spec (binary; owner-maintained). |
| [`docs/operator-runbook.md`](docs/operator-runbook.md) + [`docs/operations/`](docs/operations/) | Running a customer instance. |
| `project/README.md` + per-directory READMEs | Orientation: what lives there, allowed dependencies, governing Addendum section. |

## Repo shape

- `project/src/`: modular monolith: one directory per bounded context, two
  entrypoints (app, worker). Module rules: `project/src/README.md` (§A.1).
- `project/web/`, chat + dashboard frontend. `project/prompts/`, versioned prompt
  artifacts (§B.7). `project/infra/`, compose stack; `docker compose up` is the
  contract (§A.2). `project/eval/`, golden set and chat cases.
- `docs/`: architecture, features, security, operations, research.
- Application tests live under `project/src/`, next to the code they exercise (Vitest).
- `assets/brand/`: canonical logo files (trademarked, not AGPL: see TRADEMARK.md).
  Reuse from here; never generate, recreate, or modify the logo.

## Current state

v1.1.0 is released. The task subsystem and reminders were **removed** in V2.0 items
3.1 and 3.2: Cogeto has no tasks, no to-dos, and no reminders. What survives is
**open loops**, `commitment` and `open_loop` memories read straight from the memory
table, due-dated by `valid_until`, surfaced in chat and on the attention feed.

Work proceeds through the V2 plan in order.

## Delivery loop

Full details in [`docs/engineering-workflow.md`](docs/engineering-workflow.md).

1. **Open GitHub issues** for the unit of work, logically separated, under a shared
   label (`scripts/dev/create-issues.sh`).
2. **Branch**: `feature/<slug>`, `fix/<slug>`, or `chore/<slug>`.
3. **Implement.**
4. **Open a pull request** authored as the owner, with `Closes #N` for each issue.
   The title is a Conventional Commit.
5. **Required checks green**: `lint`, `boundaries`, `test`, `build`, `eval-gate`.
   Nothing merges without them.
6. **Squash-and-merge.** The PR title becomes the single commit on `main`.
7. **Releases are cut by the owner** tagging `vX.Y.Z`.

Issue, branch, and pull-request operations are performed via `gh` as the owner.

## Coding conventions

TypeScript strict mode. ESLint + Prettier. dependency-cruiser enforces the module map
in CI (§A.1). Zod at every boundary. pino for logging: never memory content or tokens
in logs. Tests: Vitest (unit), Testcontainers (integration), Playwright (e2e).
Vocabulary per [`docs/glossary.md`](docs/glossary.md).

**House style for prose**: no em dashes and no en dashes in product copy or
documentation. Rewrite the sentence (comma, colon, period, restructure); never
substitute a mechanical hyphen. Enforced by the `lint` check.

## Definition of done

- `docker compose up` still reaches login on a fresh clone (§A.2).
- CI module-boundary checks pass (§A.1); no cross-module table access.
- The binding invariant tests pass: scope-leak, deletion-cascade (§A.7),
  approval-gate (§A.8), golden-set eval gate (§B.4).
- Docs updated in the same change when behavior contradicts them.

## Needs owner sign-off (ask first)

- Any new dependency, framework, or the stack choice itself.
- Any deviation from an Addendum Part A decision or the §A.6 schema commitments.
- Git: **never run git commands unless explicitly asked.** The owner manages git.
- **NEVER add AI attribution to any git artifact. This is strictly forbidden.** No
  `Co-Authored-By` trailer, no "Generated with", no AI-authorship or "assisted by"
  line in commit messages, PR titles, PR bodies, issue text, or anywhere else. All
  commits and pull requests are authored solely by the owner, with no exceptions.
- Anything user-visible leaving the machine (publishing, external calls with real data).
