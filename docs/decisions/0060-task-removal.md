# 0060 — Removing the task subsystem (V2.0 items 3.1 + 3.2)

**Date:** 2026-07-28 · **Status:** accepted · **Governs:** the removal of the
task engine and reminders, what survives in their place, and the three published
contracts the removal touched. **Driven by:**
[`docs/Cogeto-V2-Plan.md`](../Cogeto-V2-Plan.md) §3.1 and §3.2 (binding), with
the complete inventory verified against
[`docs/audits/current-state-2.0.md`](../audits/current-state-2.0.md) §2.
**Supersedes:** decisions 0013, 0018, 0037, 0038 and 0054 in full — each is now
history, not guidance. Migrations this session are **0035** (the removal) and **0036** (one late
schema drop — see ruling 7).

## Ruling 1 — The task subsystem is removed entirely, with no shim

The `tasks` bounded context (21 files), the `task` and `task_conclusion` tables,
the `task_status` and `task_conclusion_type` enums, the 8 `/api/tasks`
endpoints, the `task_closure` and `task_condition` prompt families, five worker
jobs (`tasks.derive`, `tasks_backfill`, `tasks_derivation_cleanup`,
`tasks_reminders`, `email_authorship_backfill`), the reminders CLI, the Tasks
page and every tendril — nav badge, dashboard task load, attention task kinds,
the drawer's "Make this a task", the skills accept-as-task proposals, the
conversation delete preview's task count — are deleted outright.

*Why removal rather than repair:* the task engine was the most entangled
subsystem in the product and the least used part of it. It carried its own
lifecycle, its own model judgments (closure and condition), its own backfills
and phantom-cleanup passes, and its own vocabulary, to hold a concept that the
memory schema already expresses. Every one of those moving parts was a place
for the product to disagree with itself about what "still open" means. 2.0
opens by making the codebase smaller and that answer singular.

*Why no compatibility path:* **there is no deployed instance.** No shim, no
deprecation window, no read-only mode, no redirect. The one ordering
constraint that does exist is ruling 3.

## Ruling 2 — Open loops survive, read from memory

The concept the task engine existed to serve is kept, and it needs no schema of
its own. **An open loop is a memory**: `kind` in (`commitment`, `open_loop`),
status in (`active`, `user_approved`, `uncertain`). Its due date is the
memory's own `valid_until`; "gone quiet" is ingestion's existing `dormant_flag`.

- `MemoryStore.openLoopsForPrincipal` is the single gated read. It applies the
  same scope and sensitive gates as every other read — an unscoped open-loops
  query is unrepresentable, exactly as §A.4 requires.
- `RetrievalService.openLoops` layers the dormant flags on and is what BOTH the
  open-loops chat answer and the attention surface call. There is one
  definition of "still open" in the product, not two that can drift.
- Statuses that no longer stand — `outdated`, `replaced`, `contradicted` — are
  excluded structurally, so settled obligations cannot reach the answer at all.
  `uncertain` stays in and is framed softly: an unconfirmed promise is still a
  promise.
- The `commitment`/`open_loop` extraction labels, the dormant-flag table, and
  the nightly dreaming pass that writes it are all untouched.

The founding question — *"what did I decide, promise, and commit to, and what
is still open?"* — is answered by this path, with citations, and its two eval
cases (`whats_still_open`, `open_with_entity`) were kept and re-pointed at it
rather than deleted.

**What is deliberately NOT preserved:** closure and condition model judgments,
the conclusion-memory loop, supersession repointing of derived rows, the
backfills, `from_uncertain`, the adoption gesture, and the `/tasks` page. A
user-owned follow-up concept may return in a later version; it will be designed
against the 2.0 surfaces, not restored.

## Ruling 3 — `task_conclusion` memories are erased through the saga, and the enum value is permanent residue

Memories carrying `source_type = 'task_conclusion'` (decision 0037) point at
`task_conclusion` rows. Dropping that table with them present would strand §A.6
provenance and trip the integrity sweep's orphan arm (decision 0024).

So they are erased **the only way memories are ever erased**: through the §A.7
deletion saga, one enumeration transaction per source, a signed receipt each,
Qdrant points and MinIO objects removed, receipt confirmed. `npm run
erase:task-conclusions` does exactly this and must run **before** migration
0035, which refuses to drop while any such memory survives — so skipping the
step fails loudly at migrate time rather than silently later.

**The enum value itself cannot be dropped.** Postgres does not support removing
a value from an enum type, and rewriting `source_type` is not this change's
business (converting it to a registry is V2.0 item 3.6). `'task_conclusion'`
therefore stays in `source_type` **forever**, alongside `'calendar_event'`,
which became residue the same way. Both are listed in `DEFUNCT_SOURCE_TYPES`
with one binding rule for every reader:

> A defunct source type is a **known** value, never an unexpected one. No switch
> may throw on it and no sweep arm may flag it as unrecognised. It should simply
> have no rows.

The integrity sweep gained an arm that proves exactly that: a memory carrying a
defunct `source_type` is reported as an orphan, because its provenance can no
longer resolve. Expected to return nothing forever.

## Ruling 4 — `counts_json.tasks_removed` is permanently optional in the receipt schema

`tasks_removed` sat inside the **signed, hash-chained** `counts_json` of every
deletion receipt written while the task engine existed. The chain hashes the
stored `counts_json` verbatim.

- `canonicalize` and `verifyChain` are **not changed in any way**. A byte of
  difference there would invalidate every historical receipt on every instance.
- The field stays in the Zod contract, `optional()`, **permanently**. It is not
  dead code: the deletion executor re-parses stored receipts on every retry, so
  removing it would break replay of historical receipts, not merely their
  display.
- New receipts simply **omit** it. The saga no longer counts anything under it.
- `receipt-chain-tasks-removed.spec.ts` pins this: a fixture receipt carrying
  `tasks_removed`, hashed and signed with a real instance key, verifies under
  the current code; a chain mixing one historical (with the field) and one
  current (without) receipt verifies end to end; and the canonical form of a
  `tasks_removed` payload is asserted against a frozen literal.

The same reasoning applies to the audit log: nine `task.*` actions persist as
historical rows in an append-only table. They stay, and the generic renderer
copes — an audit log you can edit is not an audit log.

## Ruling 5 — The passport manifest's `tasks` key is a breaking version bump

`tasks` was a **required** key in the published manifest schema's `counts`, and
`tasks.json` a published document. Removing them is a breaking change to a
published contract, handled per decision 0029 ruling 2 rather than improvised:

- `passport_version` goes **1.0 → 2.0**.
- `docs/passport-schema/` is now versioned by directory: `2.0/` (current) and
  `1.0/` (historical, still published, still valid). A 1.0 archive remains a
  complete, verifiable artifact — verification uses the bytes and the key inside
  the archive, never the server — and the README states this in a version table.
- The in-code Zod contract and the generated sample are regenerated for 2.0; the
  `passport_schema_valid` test validates real generated bytes against the
  published 2.0 schemas, so drift still fails the build.
- The validator accepts **only** the current version for new exports. That is the
  contract 0029 asked for: an instance writes one version; readers pick the
  schema directory matching the archive's own `passport_version`.

## Ruling 6 — Reminders are dropped entirely, not rebuilt

The nightly reminders pass, its crontab line, its two `task` columns and the
standalone CLI are gone with no replacement in 2.0.

Due dates remain **visible** — through the attention surface (overdue, due-soon
and gone-quiet items, deep-linked to the fact itself) and through the memory
drawer, where a fact's validity interval already lives. What is gone is the
push: nothing stamps a reminder and nothing renders one in the digest.

A **notification layer may return later as its own feature** if design partners
ask for it. If it does, it will be built once, for every kind of thing worth
notifying about — not resurrected as a column on a table that no longer exists.

## Ruling 7 — Coordinated edits, and the migrations that enqueued task jobs

Two mechanical consequences, recorded so they are not rediscovered:

**The skill runtime.** `research_brief` proposed adoption of observed
obligations as tasks (0059 ruling 4). With nothing to adopt into, the
`propose_actions` step, the `proposed_actions` column and its endpoint are
removed, and the skill definition bumps to **`research_brief/v0002`** — skills
are versioned like prompts, so a change to the declared plan bumps the version.
Runs recorded under v0001 keep their step log and stay readable against the
v0001 declaration.

**Migrations 0014 and 0030 are neutralized in place.** Both ended with a
`graphile_worker.add_job` call for a job type that no longer has a handler.
Migrations replay from 0001 on every fresh database, so leaving them would park
a permanently failing job on every new install. The **schema statements in both
files are untouched** — they still create exactly what they always created, and
0035 drops it again — and only the queue side effect is removed, with a comment
in each file explaining why. Editing a historical migration is normally
forbidden; the narrow exception here is that the ledger records file *names*,
not checksums, and the edit removes a side effect on a queue rather than
changing any schema the ledger claims was applied.

**`chat_message.capture_content` goes too** (migration **0036**). Its only
writer was the `create_task` chat intent; with that gone the column has no
producer, and the chat SourceReader reads the raw message again. Nothing
provenance-bearing is lost — `chat_message.content`, the §A.6 target every
chat-derived memory points at, is untouched. It is a *separate* migration
rather than a line appended to 0035 because 0035 had already been applied when
the column was identified, and the ledger records migration NAMES, not
checksums: a schema statement added to an applied file would silently never
run. Schema changes always get a new number. (That is also precisely the line
the 0014/0030 edits do not cross — they removed a queue side effect, not
schema.)

**Residue kept deliberately.** `memory.authored_by_user` and
`email_message.authored_by_owner` (migration 0030) stay. The second is the
inbound routing fact from decision 0031 and was never task-specific; the first
is structural provenance metadata the pipeline still stamps at admission. Both
are harmless, and both are cheaper to keep than to migrate away.

## Consequences

- The `tasks` module is removed from `DOMAIN_MODULES` in the boundary rules; the
  module graph loses its most connected node.
- `retrieval` gains one import edge to `ingestion`'s dormant-flag consumption
  API (the barrel, acyclic — `ingestion` imports nothing from `retrieval`),
  taking over the consumer role the task engine used to hold.
- The eval surface loses the 12 task-judgment pairs, the `task-pair.json` format
  and the `derivation_traps` hard assertion; the six trap cases stay in the
  corpus with their ids and extraction labels intact, so published scores remain
  comparable. Extraction, verification and reconciliation floors are untouched.
- The digest has exactly one section again (the nightly consolidation).
