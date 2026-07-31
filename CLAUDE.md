# CLAUDE.md: how to work in this repo

Cogeto: a private, EU-hosted AI command center that turns scattered work context
(email, notes, documents, the web) into **verifiable memory**, every trust claim
backed by an inspectable artifact, with human-approved agents on top.

**The binding engineering rules live in [`AGENTS.md`](AGENTS.md). Read them first.**

## Doc map

| Doc | Read it when |
|---|---|
| [`docs/cogeto-specification.md`](docs/cogeto-specification.md) | **The normative rules.** MUST is a rule whose violation is a defect. Wins over every other doc. Cited as spec §N. |
| [`docs/cogeto-v2-plan.md`](docs/cogeto-v2-plan.md) | **Before any 2.0 work. BINDING.** The complete 2.0 plan, version by version, with priority and difficulty. |
| [`docs/cogeto-technical-architecture.md`](docs/cogeto-technical-architecture.md) | How it is built: deployment, module structure, the pipeline, access gates, the model gateway, trust machinery. |
| [`docs/cogeto-verified-memory.md`](docs/cogeto-verified-memory.md) | What is stored, what is guaranteed, and how each guarantee is enforced. |
| [`docs/features/`](docs/features/) | How a feature actually behaves and why. Start here before changing one. |
| [`docs/security/`](docs/security/) | **Single entry point for security and safety**: how the protections work, how to verify them, and the co-located tests. |
| [`docs/engineering-workflow.md`](docs/engineering-workflow.md) | **Before opening any issue, branch, or PR.** The delivery loop, Conventional Commits, required checks, tag-driven releases. |
| [`docs/glossary.md`](docs/glossary.md) | The ubiquitous language. Names in code must match it. |
| [`docs/eval-golden-set.md`](docs/eval-golden-set.md) | Corpus format, metrics, CI gates. Read before touching the extractor, a prompt, or the harness. |
| [`docs/research/*.md`](docs/research/) | **Required before implementing the matching area.** See the table in `docs/research/README.md`. |
| [`docs/cogeto-scope.md`](docs/cogeto-scope.md) | What Cogeto is, who it is for, what is in and out of scope, licensing. |
| [`docs/operator-runbook.md`](docs/operator-runbook.md) + [`docs/operations/`](docs/operations/) | Running a customer instance. |
| `project/README.md` + per-directory READMEs | Orientation: what lives there, allowed dependencies, the specification rules that govern it. |

## Repo shape

- `project/src/`: modular monolith: one directory per bounded context, two
  entrypoints (app, worker). Module rules: `project/src/README.md` (spec §15).
- `project/web/`, chat + dashboard frontend. `project/prompts/`, versioned prompt
  artifacts (spec §12.3). `project/infra/`, compose stack; `docker compose up` is the
  contract. `project/eval/`, golden set and chat cases.
- `docs/`: architecture, features, security, operations, research.
- Application tests live under `project/src/`, next to the code they exercise (Vitest).
- `assets/brand/`: canonical logo files (trademarked, not AGPL: see TRADEMARK.md).
  Reuse from here; never generate, recreate, or modify the logo.

## Current state

v1.4.0 is the current release line. The task subsystem and reminders were **removed**
in V2.0 items 3.1 and 3.2: Cogeto has no tasks, no to-dos, and no reminders. What
survives is **open loops**, `commitment` and `open_loop` memories read straight from
the memory table, due-dated by `valid_until`, surfaced in chat and on the attention
feed.

The 2.0 security audit ([`docs/audits/`](docs/audits/)) is closed out across five
remediation waves: every finding is fixed or consciously accepted with a written
rationale, and the audit and its independent verification are both published there.
Two operator-visible consequences worth knowing before changing anything nearby:
inbound email is now behind the `mail` compose profile and is **off by default**, and
the five deployment assets are checksum-verified by the installer, so editing one
means regenerating `project/infra/deploy/deploy-assets.sha256` in the same change.

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
in CI (spec §15). Zod at every boundary. pino for logging: never memory content or tokens
in logs. Tests: Vitest (unit), Testcontainers (integration), Playwright (e2e).
Vocabulary per [`docs/glossary.md`](docs/glossary.md).

**House style for prose**: no em dashes and no en dashes in product copy or
documentation. Rewrite the sentence (comma, colon, period, restructure); never
substitute a mechanical hyphen. Enforced by the `lint` check.

## Definition of done

- `docker compose up` still reaches login on a fresh clone.
- CI module-boundary checks pass (spec §15); no cross-module table access.
- The binding invariant tests pass: scope-leak, deletion-cascade (spec §11.1),
  approval-gate, golden-set eval gate (spec §14).
- Docs updated in the same change when behavior contradicts them.

## Needs owner sign-off (ask first)

- Any new dependency, framework, or the stack choice itself.
- Any deviation from a MUST rule in the specification.
- Git: **never run git commands unless explicitly asked.** The owner manages git.
- **NEVER add AI attribution to any git artifact. This is strictly forbidden.** No
  `Co-Authored-By` trailer, no "Generated with", no AI-authorship or "assisted by"
  line in commit messages, PR titles, PR bodies, issue text, or anywhere else. All
  commits and pull requests are authored solely by the owner, with no exceptions.
- Anything user-visible leaving the machine (publishing, external calls with real data).
