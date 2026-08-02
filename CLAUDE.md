# CLAUDE.md: how to work in this repo

Cogeto turns document sets into **verified, provable institutional memory**: it
reads documents including scans, verifies every fact against its own source sentence
before storing it, reports contradictions between documents, and produces a signed
findings report a third party can verify. Every trust claim is backed by an
inspectable artifact. EU hosted, self hosted, or fully offline.

**The binding engineering rules live in [`AGENTS.md`](AGENTS.md). Read them first.**

## Doc map

| Doc | Read it when |
|---|---|
| [`docs/cogeto-specification.md`](docs/cogeto-specification.md) | **The normative rules.** MUST is a rule whose violation is a defect. Wins over every other doc. Cited as spec §N. |
| [`docs/cogeto-v2-plan.md`](docs/cogeto-v2-plan.md) | **Before any 2.0 work. BINDING.** The complete 2.0 plan, version by version, with priority and difficulty. |
| [`docs/cogeto-technical-architecture.md`](docs/cogeto-technical-architecture.md) | How it is built: deployment, module structure, the pipeline, access gates, the model gateway, trust machinery. |
| [`docs/cogeto-verified-memory.md`](docs/cogeto-verified-memory.md) | What is stored, what is guaranteed, and how each guarantee is enforced. |
| [`docs/features/`](docs/features/) | How a feature actually behaves and why. Start here before changing one. |
| [`docs/features/i18n.md`](docs/features/i18n.md) | **Before touching any user-visible string.** Where the locale files are, how a language is resolved, the CI key-sync guard, and the translator workflow. |
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

V2.0 item 3.3 removed the last manual queue over facts: **Cogeto resolves its own
reviews.** Unsupported, partial, hedged and unjudgeable extractions are admitted
automatically as `uncertain` with a named sub-reason on `memory.uncertainty_reason`,
and every automatic demotion or non-admission is recorded in the content-bearing
`suppressed_fact_log` (which is therefore in the deletion cascade). The Review page
shows **contradictions only**; confirming a fact is a contextual action on the memory
drawer. There is no approval queue for facts anywhere.

V2.0 item 3.4 made the published numbers complete. The trust artifact (schema
**1.1**, additive) now carries **contradiction precision**, **supersedes accuracy**
with its denominator, and **query-rewrite routing accuracy**, per language and
aggregate; gates have a **per-language layer** so no language hides in an aggregate,
and a language `project/eval/gates.json` does not name fails the check. Every floor
is justified in [`docs/eval/gate-model.md`](docs/eval/gate-model.md), the governing
rule being: publish everything measured, gate at the honest current value, ratchet up
only, never gate at a target the project is below. Pull requests now run the **golden-set
suite against committed cached fixtures** (`project/eval/cache/`); change a prompt
and the cache misses by construction, so run `npm run eval:cache:refresh` and commit
the fixtures in the same change. A cached run can never publish a trust score. The
chat suite is deliberately not cached (retrieval returns equally scored facts in a
different order every run, so the answer prompt is not reproducible) and still runs
live post-merge.

The 2.0 security audit ([`docs/audits/`](docs/audits/)) is closed out across five
remediation waves: every finding is fixed or consciously accepted with a written
rationale, and the audit and its independent verification are both published there.
Two operator-visible consequences worth knowing before changing anything nearby:
inbound email is now behind the `mail` compose profile and is **off by default**, and
the five deployment assets are checksum-verified by the installer, so editing one
means regenerating `project/infra/deploy/deploy-assets.sha256` in the same change.

V2.0 item 3.5 made the product translatable. Every user-visible string in the
SPA is a key in `project/web/src/locales/<locale>/<namespace>.json` (21
namespaces, one per surface), the copy Cogeto writes on its own lives in
`project/src/infrastructure/locales/`, and **English is the source of truth and
the fallback for every missing key**. `hr`, `de` and `fr` exist as complete
scaffolds carrying the English text: authoring the translations is a separate
task. `npm run i18n:check` runs inside `lint` and fails the build on a missing,
orphaned or unused key, a missing plural category, a dropped `{{placeholder}}`,
an em dash in English copy, or a reintroduced hardcoded literal. Add a language
with `npm run i18n:add -- <locale>`. Two rules worth knowing before editing
anything user-facing: **never write a literal into a component** (use `t()`), and
**enum values are never translated**, only their display names, through an
explicit value to key map. Interface language is not extraction quality: only
English and Croatian have corpora and gates, and nothing in the product may imply
otherwise.

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
