# The module boundary contract

**Status: BINDING.** This is the decision record for V2.0 item 3.6 and the
specification the boundary tooling enforces. Written in part 1 (enforcement),
updated in part 2 (the entrypoints dissolution), part 3 (the source-type
registry) and part 4 (the split of the two accumulated surfaces and the end of
domain-module globality). It makes spec §15.1, §15.2 and §15.3 concrete:

> **§15.1** A boundary is imports plus table ownership plus job type contracts
> plus dependency injection tokens. Import checking alone is not boundary
> enforcement.
>
> **§15.2** A module MUST NOT write to another module's tables, and barrels MUST
> NOT re export live tables.
>
> **§15.3** Source types MUST be registered rather than enumerated in a
> database type.

Until this document existed, only the first of the four dimensions was checked,
and even that was checked incompletely. `npm run boundaries` reported **zero
violations** across 494 modules while a module could read any table in the
database through a barrel re-export, eleven of the eighteen Nest modules
bypassed the module graph entirely, and one whole bounded context was absent
from the rule set. A green check over an unenforced boundary is worse than no
check: it is a claim.

All four parts have landed. Part 1 fixed the enforcement and enumerated what
it revealed; part 2 closed every entrypoints entry on that list; part 3
delivered the source-type registry (§15.3, B16); part 4 split the two
accumulated surfaces (the connectors families and chat) and closed every
remaining recorded exception: **no domain module is global**, and the
[Recorded exceptions](#recorded-exceptions) section now records history plus
the one deliberate line (B19, the CLIs).

---

## 1. The four dimensions

A module boundary in Cogeto is the conjunction of four things. A change that
respects three of them and breaks the fourth has broken the boundary.

| # | Dimension | The rule | Enforced by |
|---|---|---|---|
| 1 | **Imports** | A module reaches another module only through its `index.ts` barrel. Internals are private. | `.dependency-cruiser.cjs` (`npm run boundaries`) |
| 2 | **Table ownership** | Every table has exactly one owning module. Only that module may name it, in Drizzle or in raw SQL. Barrels never re-export a live table. | `.dependency-cruiser.cjs` + `entrypoints/boundary-contract.spec.ts` |
| 3 | **Job-type contracts** | Every job type is declared once, as an exported constant, by the module that owns its payload contract and its handler body. Everyone else enqueues it through that constant, never a bare string. | `entrypoints/boundary-contract.spec.ts` |
| 4 | **Dependency-injection visibility** | A provider is visible only where a module declares an import. A global module is an explicit, justified exception, not a convenience. | `entrypoints/boundary-contract.spec.ts` |

Dimensions 2 to 4 are the ones import checking cannot see, which is why §15.1
names them. A module that imports nothing from `memory` and then runs
`SELECT * FROM memory` has crossed the boundary without importing anything. A
module that never imports `connectors` but injects `NotesService` because
`ConnectorsModule` is global has the same dependency, invisible to the graph.

---

## 2. Table ownership

Thirty-seven tables, one owner each. The owner is the module whose
`persistence/tables.ts` declares the Drizzle table; it is the only module that
may name the table in a query, in Drizzle or in SQL.

| Owner | Tables |
|---|---|
| `memory` | `memory`, `memory_relation`, `file_metadata`, `deletion_receipt`, `integrity_alert` |
| `ingestion` | `verification_result`, `suppressed_fact_log`, `dream_run`, `dream_action`, `dormant_flag` |
| `chat` | `chat_message`, `conversation` (moved from `retrieval` in part 4: chat is a capture connector by structure) |
| `attention` | `attention_state`, `attention_dismissal` |
| `agents` | `approval` |
| `notes` | `note` |
| `settings` | `user_settings` |
| `email` | `email_message`, `email_attachment`, `email_allowlist`, `email_refusal` |
| `research` | `web_page`, `research_run` |
| `skills` | `skill_run`, `skill_run_step` |
| `identity` | `app_user` |
| `model-gateway` | `prompt_registry` |
| `passport` | `passport_export` |
| `infrastructure` | `audit_log`, `outbox_event`, `job_execution`, `dead_letter`, `user_context`, `context_suggestion_dismissal`, `usage_counter`, `rate_limit_window` |
| `retrieval`, `operations` | none. Retrieval is pure search since part 4; operations reports on other modules' data. |

The six family rows and `chat` replaced the single `connectors` row in part 4:
the 7.9k-line context held six unrelated families, and each now owns its
tables, its jobs and its public interface.

Two schemas have no Drizzle declaration and belong to `infrastructure` as the
module that creates and runs them: **`cogeto_migrations`** (the migration
ledger, written by `infrastructure/migrations.ts` before any schema exists) and
the **`graphile_worker`** schema (created by the queue library).

The check has two halves, so neither drifts: every table a migration creates and
does not drop must have an owner, and every owner entry must name a table some
migration creates. A table that arrives without an owner fails `test`.

### Why infrastructure owns eight tables

`infrastructure` is not a bounded context and owns no domain concept. It owns
the eight tables that every context appends to and none of them owns: the audit
trail, the outbox, the queue's two ledgers, the per-user context that feeds
prompts in three different contexts and its dismissals, and the two abuse
counters shared by the app and the worker. Putting any of them inside a domain
module would make every other module a cross-module table reader, which is the
rule this contract exists to enforce.

It owned ten until part 2. The attention read-state pair was justified the same
way, "the surface spans every context and none owns it", which was true of the
surface's *reads* and false of its *state*: only the attention surface ever
writes those two tables. They moved with it (same tables, same columns, no
migration), which is what "owner" is supposed to mean.

That ownership is a **contract, not a permission**: a domain module still may
not read `audit_log` directly. It calls a function on infrastructure's public
interface, and that function is the only place the table is named.

### The reader functions

Infrastructure's public interface exposes exactly what other modules were
reaching into its tables for:

| Function | Replaces | Callers |
|---|---|---|
| `jobRunState(db, { sourceType, sourceId, jobType })` → `'done' \| 'failed' \| 'processing'` | Five byte-identical hand-rolled `job_execution` + `dead_letter` probes | `connectors` (notes, files, research, research-conclude), `retrieval` (chat) |
| `readAuditEntries(db, filter)` → `AuditRecord[]` | Three hand-rolled `audit_log` reads | `memory` (change feed, sweep status), `agents` (execution summaries), `passport` (test assertion) |
| `readAuditPage(db, filter)` → `{ rows, total }` | The `/api/audit` browse's `ILIKE` filter builder, run from a composition root | `operations` |
| `listQueuedJobs`, `recentJobExecutions`, `listDeadLetters`, `queueTotals`, `retryDeadLetter` | The queue-administration view's five raw queries and its retry transaction | `operations` |
| `InstanceProbes` (`ping`, `queueDepth`, `migrations`, `installedAt`) | The health report's four raw queries, and the capability registry's install-date read | `operations` |

`readAuditPage` takes `orgId` as a **required** argument rather than an optional
filter: the org gate is spec §4.2, so an unscoped browse of the trail is
unrepresentable, the same way unscoped memory queries are in retrieval. The
per-row owner gate on `detail_json` stays with the caller, which is where the
Principal is.

`InstanceProbes` keeps its own two-connection pool, which is why it lives in
`infrastructure` rather than in the module serving `/api/health`: the health
controller had a dedicated pool so a saturated application pool could not make
the report hang, and that property is worth keeping. But owning a `Pool` is
exactly what a domain module may not do.

Both preserve their callers' SQL exactly. `readAuditEntries` applies one
consistent ordering (`created_at DESC, id ASC`) where two of the three call
sites previously ordered by `created_at DESC` alone; a deterministic tiebreak on
a strictly weaker ordering cannot change a result that was previously
well-defined.

---

## 3. Job-type contracts

Fifteen job types. Each is declared **once**, as an exported constant, in the
module that owns the payload contract and writes the handler body. The worker
composition root is the only place that maps a job type to a handler, and it
imports every constant rather than spelling any of them.

| Job type | Owning module | Constant | Kind |
|---|---|---|---|
| `ingestion.pipeline` | `ingestion` | `INGESTION_PIPELINE_JOB_TYPE` | per-source |
| `file.discard_cleanup` | `ingestion` | `FILE_DISCARD_CLEANUP_JOB_TYPE` | per-source |
| `dreaming_cycle` | `ingestion` | `DREAM_JOB_TYPE` | recurring |
| `memory.embed` | `memory` | `MEMORY_EMBED_JOB_TYPE` | per-source |
| `deletion.execute` | `memory` | `DELETION_JOB_TYPE` | per-source |
| `deletion_sweep` | `memory` | `SWEEP_JOB_TYPE` | recurring |
| `approval.execute` | `agents` | `APPROVAL_EXECUTE_JOB_TYPE` | per-source |
| `approval_expiry` | `agents` | `APPROVAL_EXPIRY_JOB_TYPE` | recurring |
| `research.conclude` | `research` | `RESEARCH_CONCLUDE_JOB_TYPE` | per-source |
| `skill.advance` | `skills` | `SKILL_ADVANCE_JOB_TYPE` | per-source |
| `email_refusal_retention` | `email` | `EMAIL_REFUSAL_RETENTION_JOB_TYPE` | recurring |
| `conversation.title` | `chat` | `CONVERSATION_TITLE_JOB_TYPE` | per-source |
| `passport_export` | `passport` | `PASSPORT_EXPORT_JOB_TYPE` | per-source |
| `passport_retention` | `passport` | `PASSPORT_RETENTION_JOB_TYPE` | recurring |
| `demo_reset` | `entrypoints` (dev only) | `DEMO_RESET_JOB_TYPE` | recurring, profile-gated |

The rules:

1. **One declaration.** A job-type string literal appears in exactly one
   non-test file: the one that exports its constant. Its crontab constant, where
   it has one, is declared beside it.
2. **Enqueue through the constant.** A module may enqueue a job type it does not
   own (`connectors` enqueues `ingestion.pipeline` for every source it captures)
   only by importing the owner's exported constant. A bare string literal
   elsewhere is a defect: it is a contract copied by hand.
3. **The handler is the owner's.** The module that owns the type provides the
   service that executes it; the worker root wires the two together and does
   nothing else.
4. **Idempotency keys stay `(source_type, source_id, job_type)`** (spec §15.4),
   which is why the queue ledger is infrastructure's table and not any module's.

`echo` is the outbox round-trip demo defined in the worker root itself and owns
no module; it is deliberately outside this table.

One constant crosses a family boundary by VALUE rather than by import (part
4): research's settle-watcher enqueues `skill.advance` when a settled run
belongs to a skill, and the composition root passes skills' exported constant
through `ResearchModule.register({ skillAdvance })`. The declaration stays
single, the enqueue still goes through the owner's constant, and no
research → skills module cycle exists.

---

## 4. Dependency-injection visibility

Nest resolves a provider from the injector of the module that declared the
import. A **global** module is exempt: its exports resolve everywhere, in every
module, whether or not any module declares a dependency on it. That makes
globality a hole in the boundary exactly as large as the module behind it, and
it is invisible to the import graph, because the consumer has no import to check.

There is a second way a provider escapes the graph, and part 2 closed it: a
module that injects the composition root's own configuration object. Seven
controllers and two services took `COGETO_CONFIG`, which meant importing
`entrypoints/config`, the one import direction the rules forbid outright, and it
meant each of them could read anything about the deployment. Every module now
declares the fields it needs as its own options type, and the root maps its
config onto them.

### The policy

> A module may be global only if it is (a) registered exactly once per
> composition root with process-wide configuration, and (b) infrastructure or a
> seam, never a domain module. Everything else is imported explicitly. Where a
> provider must cross against the module graph, the owning module defines a port
> and the composition root passes the implementing module through the owner's
> registration options.

The last clause is not new: `MemoryModule.register` already accepts
`sourceDeletions.imports` and `derivedCascades.imports`, and
`IngestionModule.register` accepts `imports`, precisely so a source-reader or
cascade adapter can be bound without either module knowing the other. That is
the pattern; globality was the shortcut around it, and part 4 removed the
shortcut everywhere.

### The module registry, after part 4

Every module is explicit. The only global modules are the four the policy
allows:

| Module | Global? | Why |
|---|---|---|
| `DatabaseModule` | yes | One `Pool` and one Drizzle handle per process. |
| `LimitsModule` | yes | Dynamic, config-carrying; `RateLimitGuard` is applied inside domain modules. |
| `IdentityModule` | yes | A seam; `BearerAuthGuard` is the app-wide `APP_GUARD`. |
| `ModelGatewayModule` | yes | A seam; one gateway per process. |
| everything else | **no** | Composed as ONE dynamic instance per root, threaded through `imports`/registration options wherever its providers are injected. |

The composition pattern that replaced globality (B13/B14/B15): a root creates
each module instance once (`const memoryModule = MemoryModule.register({…})`)
and passes it to every consumer's registration options. Where that would form
a module cycle (memory needs a family's deletion adapter, the family needs
memory's stores), the family exposes a slim **source-ports module** in the
`ChatSourceModule` shape (reader + deletion adapter, DRIZZLE-only
dependencies) and memory imports that instead. Chat's three resolver seams
(`EmailReplyModule`, `ResearchChatModule`, `SkillsChatModule`) are dynamic
instances passed into `ChatModule.register`, whose options factory resolves
the port tokens by identity; the app root then asserts at boot that every
seam took (`ChatService.assertFullyWired`), so a wiring regression fails the
boot rather than silently disabling an intent.

### Token ownership

Every injection token is declared by, and belongs to, one module. Ports (a token
defined by the module that *consumes* the implementation) are marked.

| Owner | Tokens |
|---|---|
| `infrastructure` | `DRIZZLE`, `PG_POOL`, `RATE_LIMIT_OPTIONS`, `INGEST_QUOTA`, `RESEARCH_QUOTA`, `SSE_LIMITS`, `MODEL_USAGE_METER`, `PARSE_CAPS`, `INSTANCE_TIMEZONE` |
| `identity` | `PRINCIPAL`, `IDENTITY_OPTIONS`, `WEB_CONFIG_OPTIONS` |
| `memory` | `SOURCE_DELETIONS` (port), `DERIVED_CASCADES` (port), `INGESTION_GUARD` (port), `INSTANCE_KEY_DIR`, `SWEEP_OPTIONS`, `DELETION_SAGA_OPTIONS` |
| `ingestion` | `SOURCE_READERS` (port) |
| `retrieval` | `RETRIEVAL_SERVICE_OPTIONS` |
| `chat` | `CHAT_REPLY_RESOLVER` (port), `CHAT_RESEARCH_RESOLVER` (port), `CHAT_SKILL_RESOLVER` (port), `CONVERSATION_APPEND` (port), `CHAT_SERVICE_OPTIONS` |
| `files` | `FILE_UPLOAD_OPTIONS` |
| `email` | `MAIL_OPTIONS` |
| `research` | `RESEARCH_OPTIONS`, `RESEARCH_SYNTHESIS_OPTIONS`, `RESEARCH_CONCLUDE_WIRING` |
| `skills` | `SKILL_ENGINE_OPTIONS` |
| `model-gateway` | `MODEL_CONFIG_VIEW` |
| `passport` | `PASSPORT_OPTIONS` |
| `operations` | `OPERATIONS_OPTIONS`, `CAPABILITY_JOB_SOURCES` |
| `entrypoints` | `COGETO_CONFIG` |

`IDENTITY_OPTIONS` is deliberately absent from `identity/index.ts`: it is
DI-visible (the seam exports it as a provider so `AdminGuard` resolves inside
another module's injector) but not import-visible, which is the correct pair.

---

## 5. What enforces what

| Check | Mechanism | Runs in |
|---|---|---|
| Barrel-only imports; internals private; seams and infrastructure import no domain module; nothing imports entrypoints; client-library confinement; no cycles | `.dependency-cruiser.cjs` | `boundaries` |
| No module imports another module's `persistence/` (named exception list, **empty** since part 2) | `.dependency-cruiser.cjs` | `boundaries` |
| **No barrel re-exports a live table** (type-only exports allowed: a row shape is a contract, a table object is a handle to the data) | `.dependency-cruiser.cjs` | `boundaries` |
| Every module directory is named in the dependency rules | `entrypoints/boundary-contract.spec.ts` | `test` |
| Every table declared under exactly one module, matching the owner map | `entrypoints/boundary-contract.spec.ts` | `test` |
| Every migration-created table has an owner, and every owner names a real table | `entrypoints/boundary-contract.spec.ts` | `test` |
| No production file names another module's table in raw SQL | `entrypoints/boundary-contract.spec.ts` | `test` |
| Every recorded exception still points at a file that exists | `entrypoints/boundary-contract.spec.ts` | `test` |
| Job type declared once, in its owner, never a bare literal elsewhere | `entrypoints/boundary-contract.spec.ts` | `test` |
| The worker registers exactly the declared job types, nothing more | `entrypoints/boundary-contract.spec.ts` | `test` |
| Token declared once, by its owner, its `Symbol()` description matching its name | `entrypoints/boundary-contract.spec.ts` | `test` |
| The global-module set matches the policy allowlist | `entrypoints/boundary-contract.spec.ts` | `test` |
| Source types registered, complete, coherent; unknown and defunct values handled (spec §15.3) | `shared/src/source-types.spec.ts`, the saga's `registry_boundary` case, the sweep's `defunct_provenance_arm` case | `test` |

Both checks are required to merge (`boundaries` and `test` are two of the five
required checks; see [`engineering-workflow.md`](engineering-workflow.md)).

The spec keeps its allowlists **inline and named**, not in a data file: adding a
global module, a table, a job type or an exception is a visible edit to a file
whose comments say what each entry costs and which part removes it. A stale
entry is caught too: an exception naming a file that no longer exists fails the
build, so the list cannot quietly outlive the debt.

### The one exemption by category, and why

The raw-SQL ownership check skips `*.spec.ts`. This is stated rather than
hidden. An integration test's job is to assert against the database, and spec
§11.1 **requires** the deletion cascade to be verified across five modules'
tables at once; a rule forbidding that would forbid the test the specification
demands. Tests are still bound by the import rule: a spec may not import another
module's Drizzle table objects, because an import is compile-time coupling
rather than an assertion, and after part 2 **no spec is allowlisted for it**.

The SQL scan reads string and template-literal **contents only**, through a
hand-written scanner rather than a regex sweep, so a comment mentioning a table
is not a violation and a URL containing `//` does not truncate a literal. It
only inspects literals containing an uppercase SQL keyword, which is honest
about its limit: SQL assembled from lowercase fragments would not be seen.

---

## 6. The source-type registry

**The decision record for part 3's first slice (spec §15.3, exception B16).**
Until migration 0040, `source_type` was a Postgres enum owned by `memory`:
every new reader or connector cost a memory-owned migration
(`ALTER TYPE … ADD VALUE`) plus a hardcoded-switch edit across at least six
files, a retired value could never be dropped, and the failure mode was the
worst kind: a missed switch site breaking for exactly one source type,
silently, weeks later.

### Where source types are declared

One declaration per type, in **`project/shared/src/source-types.ts`**
(`SOURCE_TYPES`). `@cogeto/shared` is the package whose charter is the DTOs
and enums both tiers share; `MEMORY_STATUSES`, `FACT_KINDS` and
`UNCERTAINTY_REASONS` already live there and `memory`'s own tables import
them, so the vocabulary joining them follows the established direction of
dependency (shared is a leaf; everything may read it, it reads nothing).

Each descriptor carries the metadata that used to be a conditional:

| Field | Replaces | Read by |
|---|---|---|
| `defunct` | `DEFUNCT_SOURCE_TYPES` hand-list in `memory/persistence/tables.ts` | integrity sweep's defunct arm; derived `DEFUNCT_SOURCE_TYPES` export |
| `userAuthored` (`always`/`never`/`per_item`/`none`) | per-reader `authoredByUser` knowledge, undocumented | the first-person-rule contract; the registry conformance suite pins each reader's declaration |
| `objectBacked` | `sourceType === 'file'` in the deletion saga (3 sites), the passport export, the sweep | saga source resolution + file leg + discard-mode wait; passport original-bytes resolution |
| `extraction` | implicit "which types have a SourceReader" | conformance suite; container types (`chat_conversation`) and defunct types are declared, not inferred |
| `factBudget` | `payload.source_type === 'web'` cap in the pipeline | stage-3 fact cap (web 30, others the deployment cap) |
| `promptLabel` | `'user_note' ? 'note' : replace('_',' ')` in answer-prompt and context-suggestions | provenance labels inside model prompts |
| `dashboardFamily` | `SOURCE_FAMILY` map in `attention` | the sources chart |

The closed TypeScript union (`SourceTypeKey`, re-exported by `memory` as
`SourceType`) is derived from the declaration, so every internal producer
keeps compile-time safety. The SPA reads the same union: per-surface maps
(source drawer kind, citation chip label, timeline phrase, worker-activity
label) are `Record<SourceTypeKey, …>`, so **adding a source type without
deciding its treatment on a surface is a compile error, never a silent
fallback**. That is the answer to the partial-conversion failure mode. A
site that gates ONE type's unique feature (the note editor, web's URL chip,
email's reply drafts, web's research-conclusion trigger) keeps its own key,
pinned with `satisfies SourceTypeKey` where it carries behaviour.

### How a new type registers without touching `memory`

One entry in `SOURCE_TYPES`, a `SourceReader` and a `SourceDeletion` adapter
(plus optional cascade) in the owning connector module, and the
composition-root bindings through the registration options that already
exist. No migration anywhere, and no edit inside `memory`, which is what
B16 was recorded to demand.

### The column, and why text rather than enum-plus-metadata

Migration **0040** converts `memory.source_type` and
`deletion_receipt.source_type` to `text` and drops the type. Keeping the
enum as a "safety layer" under a metadata registry was considered and
rejected: it would preserve the exact costs B16 records (a memory-owned
`ALTER TYPE` migration per new type, undroppable values) and would leave
§15.3 unmet: the spec's words are "registered rather than enumerated in a
database type", and a MUST is not satisfied by adding a second mechanism on
top of the violation. There is deliberately **no CHECK constraint** either:
that would re-enumerate the vocabulary in the database with the same
migration cost per type.

The stored strings are byte-identical, and `deletion_receipt.source_type`
enters the receipt chain's canonical payload as a string, so **every
historical receipt hashes and verifies unchanged**. Reversal SQL is in the
migration header; it holds while every stored value is a registered key,
which the validation below maintains.

### How the registry preserves every property the enum enforced

| The enum's guarantee | Preserved by |
|---|---|
| An unknown value cannot be WRITTEN | The write funnel (`MemoryStore.insertFact`) and the deletion saga's API boundary both reject unregistered values; every internal producer is typed with the closed union |
| An unknown value cannot be READ (it could not exist) | It can now exist only via a manual SQL write; the integrity sweep's defunct arm extends to flag any unregistered value as `orphaned_memory`, so the state is detected within one sweep cycle instead of being unrepresentable |
| Defunct values remain valid forever | They stay registered (`defunct: true`); receipts citing them verify, the sweep proves they have no rows, and the 1.x upgrade CLI still binds its `task_conclusion` adapter |
| A closed vocabulary at compile time | `SourceTypeKey` from the registry declaration |
| Index and equality semantics | `memory_source_idx` is rebuilt on the same columns; nothing ordered by the enum's declaration order |

Enforced by: `project/shared/src/source-types.spec.ts` (the conformance
suite: completeness, coherence, per-type behaviour pins, unknown/defunct
handling), the saga's `registry_boundary` integration case, and the sweep's
`defunct_provenance_arm` case, all inside the required `test` check.

---

## Recorded exceptions

Every one of these was invisible before part 1 and is enumerated now. None is a
behaviour change; all are enforcement debts with an owner.

### Closed in part 1 (enforcement)

| # | Violation | Fix |
|---|---|---|
| B1 | `infrastructure/index.ts` re-exported ten live Drizzle tables (spec §15.2 MUST) | Re-exports removed; a rule now forbids it |
| B2 | `connectors` (notes, files, research, research-conclude) and `retrieval` (chat) each hand-rolled the same `job_execution` + `dead_letter` probe against a table they do not own | One `jobRunState()` on infrastructure's public interface; five call sites collapsed |
| B3 | `memory` (change feed, sweep status) and `agents` (execution summaries) read `audit_log` directly | `readAuditEntries()` on infrastructure's public interface |
| B4 | `passport`'s deletion integration spec read `audit_log` directly | Uses `readAuditEntries()` |
| B5 | `passport` appeared in no dependency-cruiser rule, so nothing forbade a seam or infrastructure importing it | Added to the module lists; a spec now compares the rule set against the module directories |
| B6 | `UserContextModule` and `ChatSourceModule` were global with no reason the policy accepts | Un-globaled; six explicit imports added |
| B7 | `entrypoints/demo/ops.ts`, `entrypoints/eval-chat.ts` and `entrypoints/worker-tasks.ts` spelled `dreaming_cycle`, `ingestion.pipeline` and `memory.embed` as bare string literals | Replaced with the owning module's exported constant |

### Closed in part 2 (the entrypoints dissolution)

`entrypoints/` held seven production controllers, two services and raw SQL
spanning six modules' tables. Every entry below was an entrypoints exception,
and every one is gone: the dependency-cruiser table-ownership allowlist is now
**empty**.

| # | Violation | Fix |
|---|---|---|
| B8 | `entrypoints/audit.controller.ts` queried `audit_log` with an `ILIKE` filter builder | `readAuditPage()` on infrastructure's public interface; the controller moved to `operations` and keeps only what needs the Principal (the org argument and the per-row owner gate) |
| B9 | `entrypoints/jobs.controller.ts` queried `job_execution`, `dead_letter` and the `graphile_worker` schema, and re-enqueued from a dead letter | Five readers plus `retryDeadLetter()` on infrastructure's public interface; the controller moved to `operations` |
| B10 | `entrypoints/attention.service.ts` queried `attention_state` and `attention_dismissal` | Both tables moved to the new `attention` context with the service and its two controllers. The surface owns its own state now, so there is nothing to allowlist |
| B11 | `entrypoints/capabilities.ts` read `cogeto_migrations` in raw SQL | `InstanceProbes.installedAt()`; the registry moved to `operations` |
| B18 | `entrypoints/health.controller.ts` read `cogeto_migrations`, `dead_letter` and the `graphile_worker` schema in raw SQL, on a `Pool` it opened itself | `InstanceProbes` in `infrastructure`, which keeps the dedicated two-connection pool; the controller moved to `operations` |
| B17 | `connectors/context-suggestions.spec.ts` imported two infrastructure tables to reset them between cases | A fresh user id per case needs no reset; the two remaining assertions go through `UserContextService.get()` |

Three more controllers had exactly one owner each and moved to it: `/api/settings/model-config`
to **`model-gateway`** (it displays the seam's own resolved configuration),
`/api/config` + `/api/config/demo-login` to **`identity`** (the login bootstrap
and the one credential exchange that mints a session), and
`/api/instance/public-key` to **`memory`** (the verification key for the receipts
that module signs, beside `/api/receipts` and `/api/integrity`).

Each moved surface stopped injecting the whole `CogetoConfig`, a composition
root's type that no module may import, and declares the fields it actually
reads instead (`OperationsOptions`, `WebConfigOptions`, `ModelConfigView`). That
list is now a written answer to "what does this surface know about the
deployment", which was previously "all of it".

### Closed in part 3, first slice (the source-type registry)

| # | Violation | Fix |
|---|---|---|
| B16 | `source_type` was a hard Postgres enum owned by `memory`, so every new reader cost a memory-owned migration and a switch edit in six files | The source-type registry ([section 6](#6-the-source-type-registry)): migration 0040 converts both columns to text, the vocabulary and its metadata are declared once in `@cogeto/shared`, every per-type switch reads the registry, and the SPA's per-surface maps are compile-forced complete |

### Closed in part 4 (the split of the accumulated surfaces)

| # | Violation | Fix |
|---|---|---|
| B13 | `MemoryModule` was a global domain module | ONE dynamic instance per composition root, threaded through every consumer's registration options; the memory ↔ family cycles are broken by slim source-ports modules (DRIZZLE-only reader + deletion adapters, the `ChatSourceModule` shape) |
| B14 | `ConnectorsModule` was a global domain module holding six unrelated families | The context is dissolved: `notes`, `files`, `email`, `research`, `skills` and `settings` are separate modules, each owning its tables, jobs and public interface, all explicit |
| B15 | `EmailReplyModule`, `ResearchChatModule`, `SkillsModule` were global only to bind chat's resolver ports | Chat left retrieval for its own `chat/` context; the three resolver modules are dynamic instances passed through `ChatModule.register`, and the app root asserts full wiring at boot |
| B20 | `files/files.service.ts` scheduled the discard-cleanup backstop with a raw `graphile_worker.add_job` | `enqueueDelayedJob()` on infrastructure's public interface; the queue schema is named only by its owner |
| B21 | `testing/pg.ts` named the queue's `_private_jobs` table for its settle probe | `settleQueueBookkeeping()` on infrastructure's public interface; the harness calls it |

Part 4 also removed the hazard that made B15 dangerous to close earlier:
five trailing `@Optional()` constructor parameters on `ChatService` (and the
same pattern on the saga, the sweep, retrieval, synthesis and the skill
engine) whose POSITION was load-bearing across nine manual construction
sites. Optional collaborators now arrive in one named options object per
service, resolved by token identity, with a boot assertion in the app root,
so "silently null with every test green" is no longer a reachable state.

### B19: the CLIs, which is what `entrypoints/` is for

`entrypoints/{vector-smoke,eval-chat}.ts` and `entrypoints/demo/{ops,seed,assertions}.ts`
reach into six modules' tables in raw SQL, and they keep doing so. This is not a
deferral, it is the line: **a command-line tool that builds or asserts on a
fixture world reaches the database directly, and that is what makes it a tool
rather than a request path.** Every one is named in the spec's allowlist, and
none ships in the production image; item **3.7** evicts the demo and dev-seed
ones from the image entirely.

**B12 belongs here too, and part 1 was wrong about it.** The record said
`erase-task-conclusions.ts` would be *deleted* in part 2 because it is "dead
once no instance predates 2.0". That condition is not met: migration 0035
refuses to drop `task_conclusion` while memories still carry that provenance and
names this command in its error, and
[`operator-runbook.md`](operator-runbook.md) §6a documents it as the required
step for an instance upgrading from the 1.x line. Deleting a load-bearing
upgrade tool to satisfy a checklist entry would be the wrong trade. It stays,
as a CLI, until the 2.0 release notes can declare that upgrade path closed.

### What the two parts cost, measured

| | Before part 1 | After part 1 | After part 2 |
|---|---|---|---|
| Dimensions enforced | 1 of 4, incompletely | 4 of 4 | 4 of 4 |
| Reported violations | 0 (over unenforced boundaries) | 7 fixed, 14 recorded | 13 fixed, 6 recorded + the CLI line |
| Table-ownership allowlist | n/a | 4 files | **empty** |
| Production controllers in a composition root | 7 | 7 | **0** |
| Production services in a composition root | 2 | 2 | **0** |

After parts 3 and 4 the exception count is **zero**: the raw-SQL allowlist
holds only the B19 CLI line, the global-module allowlist holds only the four
policy-approved infrastructure/seam modules, and every table, job type and
token has exactly one owner in the maps above.

---

## Changing this contract

- **Adding a table**: declare it under exactly one module's `persistence/`, add
  it to the owner map here and in the spec. A table with no entry fails `test`.
- **Adding a job type**: export the constant from the owning module, add the row
  above, register the handler in the worker root. An unregistered type, or a
  type with no declaration, fails `test`.
- **Adding a global module**: state the reason here against the policy in §4 and
  add it to the allowlist. If the reason is "it was easier", the answer is no.
- **Adding a controller or a service**: it belongs to the module that owns its
  data. If it genuinely spans several, give it a declared context of its own
  (`attention`, `operations`), never a composition root. See
  [`project/src/entrypoints/README.md`](../project/src/entrypoints/README.md).
- **Needing configuration in a module**: declare the fields as the module's own
  options type and let the composition root map them. Injecting `COGETO_CONFIG`
  means importing an entrypoint, which the rules refuse.
- **Removing an exception**: delete the row, delete the allowlist entry, and the
  check starts enforcing it. That is the whole point of enumerating them.
