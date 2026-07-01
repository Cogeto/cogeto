# Project structure lessons

Distilled from studying the repository organization of several long-lived codebases:
a large multi-agent platform (~170k lines, studied purely for structure and hygiene),
a monorepo agent framework, and two memory libraries. Pattern → rationale →
application; Cogeto mapping at the end.

## 1. Organize by feature/domain, not by technical layer

**Pattern:** The legible codebases group code by domain concern (one directory or
route-file per feature), not by technical kind (all models here, all handlers there).
A newcomer finds "everything about approvals" in one place. The studied platform's
route layer — one file per product feature, each importing exactly the domain
entities it needs — scaled past 25 feature areas without becoming a mesh; its
counterexample was a lifecycle/startup function that initialized every subsystem
inline and became the coupling hotspot of the codebase.

**Application:** Cogeto's bounded contexts (Addendum §A.1) are this pattern with
teeth. The lesson to carry: watch the entrypoints — `src/entrypoints` is where
"initialize everything inline" erosion will try to happen. Keep composition roots
declarative (a list of modules wired up), and let each module own its startup.

## 2. Boundaries erode unless something fails the build

**Pattern:** Every studied codebase that *kept* its boundaries enforced them
mechanically: lint rules on imports, per-package manifests in a monorepo, conformance
test suites that all implementations of an interface must pass. Where enforcement
was social convention only, cross-module imports accumulated (the studied platform's
densest feature file imports from 15+ sibling modules).

**Application:** Cogeto's CI must enforce §A.1 from the first pipeline: an
import-linter/architecture test asserting (a) modules import only each other's public
interfaces, (b) the two seams import no domain module, (c) nothing imports
entrypoints. Add a conformance suite for the vector-store interface (any adapter must
pass it) — this is also how `reindex` stays honest.

## 3. One aggregate concern per file; mixins/god-objects are a smell with a shelf life

**Pattern:** The platform decomposed its central agent class into 14 single-concern
mixins — workable because each mixin was focused and the composition order was
documented, but it left the core class untestable in isolation (no per-mixin tests
existed) and made the constructor signature a fragile contract. The framework
monorepo's alternative — small typed interfaces with pluggable implementations —
tested far better.

**Application:** Prefer explicit interfaces + composition over inheritance tricks in
Cogeto's domain code. The `Memory` aggregate is one class with invariants, not a
stack of mixins; anything pluggable (vector store, model provider, queue) gets an
interface + conformance tests.

## 4. Configuration: typed schema, validated once, layered predictably

**Pattern:** The robust configuration designs share: a typed schema (validated at
startup, not per-request), explicit layering (code defaults → env vars with a
namespaced prefix and nesting convention → optional file), `.env.example` documenting
every variable, secrets only via env/secret files (never code fallbacks), and — for
containerized deploys — an entrypoint that actively reconciles config paths with
mounted volumes rather than hoping.

**Application:** Cogeto adopts all of it: one typed config module per process,
`COGETO_`-prefixed env vars with `__` nesting, validation at boot (a misconfigured
instance must fail to start, not fail on request), `.env.example` in `infra/`, and
compose entrypoints that pin data paths to volumes (§A.2's zero-click bootstrap
depends on this).

## 5. The compose file is the product's front door

**Pattern:** In the self-hostable systems studied, `docker compose up` quality
correlated directly with contributor traction: bind-mounted persistent volumes,
separate containers per process (not per module), non-root users, and first-run
seeding in the entrypoint. Builds that needed undocumented steps stalled newcomers.

**Application:** Already binding as §A.2 ("one command to usable login, or the build
is broken"). The studied detail worth copying: treat the *first-run experience* as
code — bootstrap provisioning, bucket init, migration init container are all
first-class, reviewed artifacts in `project/infra/`, not README instructions.

## 6. Design docs live in the repo and version with the code

**Pattern:** The healthiest studied codebase ships a design doc per major subsystem,
updated in the same change that alters behavior, plus per-release notes. Its measured
hygiene: exactly one TODO comment in ~170k lines, consistent naming conventions
(predictable file-name suffixes per kind), and lint/type-check configured in the
build. That discipline is why the codebase stayed navigable at scale.

**Application:** Cogeto already has the skeleton: specs + Addendum in `docs/`,
decision records in `docs/decisions/`, research in `docs/research/`. The rule to
adopt: **behavior changes that contradict a doc update the doc in the same change**;
decision records are numbered and short; naming conventions are set once (first
coding session) and enforced by lint. TODOs in code require an issue reference or
they fail review.

## 7. Tests mirror the module map; conformance suites for seams

**Pattern:** Test suites organized by domain (mirroring the source layout) stayed
maintainable; suites organized ad hoc drifted. The monorepo's standout practice:
a shared conformance test package that every implementation of the persistence
interface must pass — implementations differ, guarantees do not. Observed gap in
the platform: its most complex composition (the mixin stack, the DSL parser) had
no tests at all — complexity and coverage were inversely correlated exactly where
that is most dangerous.

**Application:** Cogeto's tests mirror `src/` per module, plus cross-module suites
for the binding invariants: the deletion-cascade test (§A.7 step 5 — a
definition-of-done gate), the scope-leak test (no query path returns unscoped rows),
approval-gate tests (execution only from `approved`), and the golden-set eval gate
(§B.4). Write the conformance suite for the vector-store and queue seams when the
interfaces are defined — before the second implementation, not after.

## 8. Version everything a user or agent depends on

**Pattern:** Long-lived systems version and changelog three things: releases
(with additive/breaking labeling), schemas/migrations, and — in the AI-era codebases
— prompts. The systems that versioned prompts could attribute quality regressions;
those that didn't, couldn't.

**Application:** Cogeto: migrations numbered from 0001 (§A.6); prompts versioned,
immutable once released, changelogged, CI-evaluated (§B.7); decision records
numbered (`docs/decisions/`). One discipline, three artifact types.

## Application to Cogeto — summary

| Lesson | Cogeto realization |
|---|---|
| Domain-first organization | bounded contexts under `project/src/` (§A.1) |
| Mechanical boundary enforcement | import-lint + architecture tests in CI, rule set §A.1 |
| Interfaces over mixins/god-objects | aggregate + seam interfaces + conformance tests |
| Typed, layered, boot-validated config | `COGETO_*` env schema, fail-fast startup, `.env.example` |
| Compose as front door | §A.2 contract; bootstrap as reviewed code |
| Docs version with code | spec/Addendum/decisions/research in-repo; same-change updates |
| Tests mirror modules + invariant suites | cascade, scope-leak, approval-gate, eval-gate tests |
| Version schemas, prompts, releases | migrations 0001+, prompt families (§B.7), decision log |

One-line takeaway: structure survives only where a build fails when it is violated —
put the module rules, the scope filter, the cascade, and the golden set behind CI
gates and the architecture defends itself.
