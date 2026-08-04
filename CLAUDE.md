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
| [`docs/module-boundary-contract.md`](docs/module-boundary-contract.md) | **Before adding a table, a job type, a DI token, or a module, and before making one global. BINDING.** Which module owns what, the global-module policy, what enforces each rule, and every recorded exception with the part that closes it. |
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

v1.4.1 is the current release line. The task subsystem and reminders were **removed**
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
with `npm run i18n:add -- <locale>`; add a KEY to an existing feature with
`npm run i18n:sync`, which backfills the other locales from `en` without ever
overwriting a translation. **The rules that bind every change touching
user-visible copy are in [`AGENTS.md`](AGENTS.md) under "User-visible copy", and
a feature is not done until its keys exist in every locale.** Interface language
is not extraction quality: only English and Croatian have corpora and gates, and
nothing in the product may imply otherwise.

V2.0 item 3.6 made the module boundary real and then moved the code behind it, in
four pull requests. **Read [`docs/module-boundary-contract.md`](docs/module-boundary-contract.md)
before adding a table, a job type, a DI token or a module.** A boundary here is
**imports plus table ownership plus job-type contracts plus DI visibility**, and all
four are machine-checked: `boundaries` covers imports and forbids a barrel from
re-exporting a live table, and `entrypoints/boundary-contract.spec.ts` (inside `test`)
verifies the owner of every table, job type and token plus the global-module
allowlist. What changed underneath: `connectors/` dissolved into six family modules
(`notes`, `files`, `email`, `research`, `skills`, `settings`); **chat left retrieval**
for its own context and `chat.service.ts` became an orchestrator with explicit intent
handlers; `entrypoints/` gave up its seven controllers and two services and now holds
composition roots, root wiring and CLIs only, with `attention` and `operations` as
new declared contexts; **`source_type` is a registry, not a Postgres enum** (migration
0040), so a new source type is a declaration plus its ports, never a migration; and
**no domain module is global**: each root builds one dynamic instance and threads it
through every consumer's registration options.

V2.0 item 3.7 closed the correctness and hygiene debts the audit itemized, most of
which the five security waves had already absorbed. What is new: **file downloads and
model-gateway egress are audit-logged** (a presigned URL and a call to a rented model
are both moments something leaves the box), every audit writer with an owner now
stamps an org, `GET /api/receipts/verify` no longer hands an ordinary caller the
instance-wide counts, the **unscoped `MemoryStore` reads live in a `MemorySystemStore`
the app composition root does not provide** (so an ungated corpus read is
unrepresentable in the process that serves requests), and **chat capture stamps the
owner's default scope** instead of falling to the pipeline's `private` fallback like
no other connector. Consolidation was deliberately narrow and mechanical: one
Zod-to-400 adapter (`parseOrBadRequest`), one research citation-marker grammar in
`@cogeto/shared`, one scope-and-sensitive gate expression
(`memory/domain/scope-gate.ts`) serving both gated tables, and 230-odd unused barrel
exports removed.

V2.1 item 4.1 delivered its **native-format half**: Cogeto reads **XLSX and CSV**,
and a format is now a **registered reader** (`project/src/files/reading/`) rather than
a branch in a switch. Selection is by **magic bytes with the declared type and the
extension as hints**, so a mislabelled upload is routed by what it is or refused;
DOCX and XLSX are both ZIP, so the sniff inspects the package entries. PDF and DOCX
moved behind the seam **byte-identically**, proved against the pre-seam code copied
into the spec. A reader emits text plus a **structured locator** per segment (page,
paragraph, or sheet + row + A1 cell range + columns) that nothing downstream consumes
yet, because V2.2 and V2.3 render it; the pipeline contract is unchanged. Spreadsheets
become **statements, not grids**: column context on every row, headers found under
title blocks, merged cells resolved, formulas contributing their computed value and
never their text. Row caps are per sheet and per file, and a truncated read **says so**
on the source (`file_read_report`, migration 0041, owned by `files`, in the deletion
cascade) instead of quietly looking whole. That row also separates
**`unsupported_format` from `read_failed`** and labels an unreadable file `empty` /
`no_text`, which is the hook the OCR and vision half replaces with recovered text.
The OCR and vision half followed: a page that is a picture is read by a
**deterministic, cheapest-first ladder** (usable text layer, then local
Tesseract with en/hr/de data, then a vision model), and a page that cannot be
read says so instead of arriving as done-with-zero-facts. **Vision is a PROBED
capability**: the probe sends a real image, because a GGUF model is multimodal
only when its multimodal projector is loaded and nothing in its name says which
way it was served. Redaction and vision are mutually exclusive and fail closed.
The tier is recorded on the provenance locator; caps bound image work by
construction; `needs_vision` is a state about the INSTANCE, so a source can be
**reprocessed** once the capability arrives, and reprocessing reconciles rather
than duplicating. The vision path is deliberately NOT gated in CI, because
gating it would need a vision model in CI.

**Before changing anything in the reading path, read
[`docs/features/reading.md`](docs/features/reading.md).**

V2.1 item 4.3 delivered the **per-source extraction gate** (spec 1.6, migration
0042): extraction is admission controlled per owner and source kind, at one
deterministic chokepoint in the pipeline before any model call. Enable/disable,
fact budgets (tightest of parse cap, registry budget, gate budget), retention
(stamps `valid_until` only on facts without their own validity; the dreaming
staleness pass handles the lapse), and allow/deny rules (`document_class` =
the reading layer's detected format; `source_id` deny-only; `channel`/`folder`
reserved for connectors and bulk import). Refusals are a metadata-only ledger
(`extraction_gate_refusal`, 30-day prune, in the deletion cascade) so a gated
source never looks processed-with-zero-facts, and an absent gate row is
byte-identical to prior behaviour. The Settings page has the surface; the
tables and the API are `ingestion`'s. Spec 1.7 (injection defence for observed
content) was found already satisfied by the SEC-4 fence and guards, so no
prompt changed and the eval cache is untouched:
[`docs/features/extraction-gate.md`](docs/features/extraction-gate.md).

Work proceeds through the V2 plan in order, with one owner-approved insertion:
reasoning-model support Part B (the probed `reasoning` capability and the
maxTokens headroom) landed 2026-08-04; Parts A (the thinking channel) and C
(storage and UI) follow after V2.1 item 4.2.

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
- **Every string the feature added is a key, present in every locale**
  (`npm run i18n:check` is part of `lint`). A feature that ships English text
  hardcoded in a component, or a key only `en` has, is not done.
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
