# Cogeto — current-state audit for the 2.0 refactor

**Date:** 2026-07-27 · **Tree:** `main` @ `7afd56d` (post-v1.1.0) · **Read-only audit; no code changed.**
Scope: everything under `project/` plus prompts, migrations, evals, and published contracts. Line
references are from the working tree at audit time. Method: parallel code sweeps cross-checked
against the binding docs (Addendum, Roadmap Revision, decisions 0001–0059).

Codebase size: ~483 TS/TSX files, ~50.9k non-spec LOC + ~23.5k spec LOC, 34 migrations, 59 decision
records, 27 prompt families/versions (14 stale), zero TODO/FIXME markers anywhere — the debt is
structural, not annotated.

---

## 1. Module map

`npx depcruise`: **0 violations, 517 modules, 2,739 dependencies, no cycles.** That number flatters
the codebase; see "what the tool misses" below.

### 1.1 Modules as implemented

| Module | Prod files / LOC | Real responsibilities | Public interface (Nest exports) |
|---|---|---|---|
| memory | 26 / 5,802 | `MemoryStore` (1,363 L, 38 methods: CRUD, status FSM, 3 search primitives, point-in-time), deletion saga + hash-chained receipts, reconciliation state mutation, integrity sweep, MinIO/Qdrant stores, 6 controllers | `MemoryStore, TimelineService, MemoryReconciliation, DeletionSaga/Executor, IntegritySweep, MemoryObjectStore, MemoryFileStore` — **global** |
| ingestion | 28 / 3,621 | pipeline (chunk→extract→verify→embed→reconcile), dreaming + digest, temporal resolver, email preprocess, dormant flags, 3 eval harnesses; `verification.controller.ts:26` mounts on `@Controller('memories')` (memory's namespace) | `IngestionPipeline, DreamingService` |
| retrieval | 22 / 3,611 | `RetrievalService` (RRF fusion + status multipliers) — and the entire **chat area** (15 files): `ChatService` (1,154 L), conversations, intent routing (`query-rewrite.ts`, 697 L), SSE, capture | `RetrievalService` |
| agents | 12 / 930 | approval state machine + executor + exactly 2 registered actions (bulk-outdate, email-reply-draft) | `ApprovalService, ApprovalExecutor` |
| connectors | 57 / 7,931 | **six unrelated families**: notes, files, email (14 files), web research (13), named skills (`skills/`, 10), user settings/context. 12 controllers, 10 tables, imports 8 other modules | ~50 barrel symbols, 18 providers — **global** ×4 sub-modules |
| tasks | 13 / 2,088 | `TasksEngine` (1,045 L): derivation, closure/condition judging, reminders, dormancy sync, conclusions-as-source, digest section, deletion cascade | `TasksEngine, TasksCascade`, `DIGEST_TASK_SECTION` (**global**) |
| identity | 12 / 525 | Zitadel OIDC seam: token→Principal (userinfo call, TTL cache), default-deny guard, AdminGuard, UserDirectory. Owns `app_user` (README claims "no tables") | `IdentityService, BearerAuthGuard, AdminGuard, PRINCIPAL` — **global** |
| model-gateway | 18 / 2,275 | provider-neutral gateway; mistral/openai/anthropic adapters + ollama flavor; decorator stack (tier-routing → redaction → budget); prompt registry (owns `prompt_registry`; README claims "no tables") | `ModelGateway` only — **global** |
| passport | 11 / 1,051 | Memory Passport export: assembler, Zod format, ZIP, worker executor | `PassportExportExecutor, PassportExportStore` |
| infrastructure | 19 / 1,535 | db/outbox/queue/audit/limits — **plus misplaced domain code**: `user-context.ts` (243 L, profile/timezone/language) and `context-block.ts` (prompt preamble) | `DRIZZLE, PG_POOL`, `UserContextService` — **global** ×3 |
| entrypoints | 47 / 7,294 | 2 composition roots, config (420 L), 12 operator CLIs, eval harnesses (`eval-chat.ts` 1,196 L), demo — **plus 8 production controllers** and `AttentionService` (450 L), `CapabilitiesService` (371 L) | none (no barrel) |
| testing | 5 / 241 | Testcontainers harness | — |
| migrations | 34 SQL | one flat, unowned namespace; migrations for 3+ modules' tables interleave freely | — |

### 1.2 Dependencies (prod imports; spec-only edges excluded)

| Module | Imports from | Imported by |
|---|---|---|
| infrastructure | — (leaf, nominally) | all 11 |
| identity | infrastructure | 8 modules |
| model-gateway | infrastructure | 6 modules |
| memory | identity, infrastructure, model-gateway | 7 modules |
| ingestion | + memory | retrieval, connectors, tasks, entrypoints |
| tasks | + ingestion, memory | retrieval, connectors, passport, entrypoints |
| retrieval | + tasks (non-optional: `retrieval.service.ts:7`) | connectors, entrypoints |
| agents | identity, infrastructure, memory | connectors, entrypoints |
| passport | identity, infrastructure, memory, tasks | entrypoints |
| connectors | **8 modules** (identity 23, infrastructure 43, memory 14, ingestion 13, model-gateway 12, retrieval 11, agents 2, tasks 1) | entrypoints |
| entrypoints | all 10 (141 edges) | — |

Prod layering is acyclic: `infra/seams → memory → ingestion → tasks → retrieval → agents →
connectors → entrypoints`. Spec files invert it: memory's deletion-cascade integration tests import
five downstream modules — the saga cannot be tested without the whole system.

### 1.3 What dependency-cruiser enforces vs. misses

Enforced (`.dependency-cruiser.cjs`, 14 rules): barrel-only cross-module imports, no cross-module
`persistence/` imports, seams import no domain module, nothing imports entrypoints, per-SDK
containment (qdrant→memory only, provider SDKs→model-gateway only, oidc→identity only), no cycles,
shared-is-a-leaf, web-imports-no-backend.

**Not caught:**

| Gap | Evidence |
|---|---|
| **Barrel laundering of persistence** — rule 4's own comment claims re-exports are blocked; they are not | `infrastructure/index.ts:34-43` re-exports **8 live Drizzle tables** (`auditLog`, `deadLetter`, `jobExecution`, …); 7 modules `.select()/.insert()` them directly (e.g. `tasks/tasks.engine.ts:11`, `retrieval/chat/chat.service.ts:20`, `connectors/files.service.ts:13`). `memory/index.ts:37,84` and `tasks/index.ts:29` re-export row types/stores the same way |
| **Global Nest modules** — 7 of 11 modules are `global: true`; DI edges exist with no import edge | `tasks.module.ts:44-53` documents `forDigest()` as a deliberate workaround so ingestion injects `DIGEST_TASK_SECTION` "without ever importing tasks"; 36 `@Optional() @Inject` sites |
| **Raw SQL** — a string is invisible to the graph | `entrypoints/eval-chat.ts` has 9 raw-SQL blocks over six other modules' tables (`:559,:640,:695,:749,:830,:870,:889,:922`); `entrypoints/demo/ops.ts` similar |
| **`passport` missing from `DOMAIN_MODULES`** (`.dependency-cruiser.cjs:5`) — seam/leaf rules silently don't apply to it | one-word config bug |
| **Job-type contracts** — 20 bare string constants, hand-registered in `worker-tasks.ts` which imports from 9 modules; naming mixes `snake_case`/`dotted.case`; no payload schema beyond `{source_type, source_id}` | `infrastructure/outbox.ts:10-15` |
| **`source_type` pgEnum lives in memory but its values are owned elsewhere** — `'user_note','email','file','web'` (connectors), `'chat','chat_conversation'` (retrieval), `'task_conclusion'` (tasks). Adding a connector requires a memory migration | `memory/persistence/tables.ts:22-39` |
| **Inverted ownership** | `ingestion/index.ts:72-73` defines *tasks'* job-type constants; `connectors/email-authorship-backfill.ts:8` imports a tasks job type (connectors→tasks edge); the email reply-draft *action* lives in agents while its service lives in connectors |
| **The "entrypoints aggregate pattern"** — anything spanning ≥2 contexts is pushed to `entrypoints/` and its tables to `infrastructure/` (attention, dashboard stats, capabilities, audit reader, jobs, health). Net: entrypoints is a 13th, undeclared bounded context and infrastructure is the table dumping-ground — a *legal* dodge of rule 4 | `attention.service.ts:31-36`, decision 0039 ruling 2 |

---

## 2. The task subsystem — complete removal map

Everything below must change to remove tasks with zero leftovers. Full file:line detail was
verified in code, not docs.

### 2.1 Own artifacts (delete outright)

| Layer | Inventory |
|---|---|
| Module | `project/src/tasks/` — 21 files, 3,886 lines (engine 1,045 L; controller; cascade; digest section; conclusion builder + source ports; derivation rule; visibility gate; eval harness; 7 spec files) |
| Tables | `task` (migration 0014 + 0017 reminder cols + 0030 `adopted`), `task_conclusion` (0025). 6 indexes. No triggers |
| Enums | `task_status` (0014:6), `task_conclusion_type` (0025:21), TS mirrors in `project/shared/src/memory.ts:28-31` |
| Endpoints | 8 under `/api/tasks` (`tasks.controller.ts:61-141`): list, count, conclusions ×2, adopt, reopen, dismiss, complete |
| Prompts | whole families `task_closure/` and `task_condition/` (both v0001); **task sections inside shared prompts**: `answer/v0006.md:15,166-179` (tasks mode + "Open loops" rules), `query_rewrite/v0005.md:21,45-51` (`open_loops` field in every example), `prompts/README.md:14` |
| Jobs | `tasks.derive`, `tasks_backfill`, `tasks_derivation_cleanup`, `tasks_reminders` (crontab `40 3 * * *`), plus `email_authorship_backfill` (exists *only* to feed the derivation rule). Outbox events `task.concluded`, `chat.task_requested`. Standalone CLI `entrypoints/reminders.ts` + npm script |
| Web | `pages/Tasks.tsx` (320 L) + route; nav badge (`Nav.tsx`, `Shell.tsx`); `StatsPanel.tsx:222-259` TaskLoad; attention-model task kinds; `MemoryDrawer.tsx:314-317` "Make this a task"; `SourceDrawer.tsx:406-426` conclusion provenance; `Skills.tsx` accept-as-task; conversations delete preview; `api.ts:245-276`; query keys `['tasks']`, `['task-count']` |
| Evals | 12 `task-pair.json` cases (6 en/6 hr), 6 derivation-trap assertions in `expected.json` (hard build gate), 7 of 27 chat cases (`create_task_en/hr`, `closure_flow`, `whats_still_open`, `open_with_entity`, both `skill_brief_*` assert zero tasks), task column in every eval report, CI path filter `.github/workflows/ci.yml:155` |
| Docs | 5 decisions fully about tasks (0013, 0018, 0037, 0038, 0054), glossary entries, runbook sections, `.dependency-cruiser.cjs:5` |

### 2.2 Columns on OTHER tables (do not delete blindly)

| Column | Owner table | Consumers |
|---|---|---|
| `memory.authored_by_user` (0030:20) | memory | only `tasks/derivation-rule.ts:41` — dead after removal, but harmless to keep |
| `email_message.authored_by_owner` (0030:21) | connectors | intake routing fact; independent of tasks, keep |
| `chat_message.capture_content` (0025:51) | retrieval | written only by the create_task intent (`chat.service.ts:902`), read by the chat source reader — removable with the intent |
| `source_type` value `'task_conclusion'` (0025:19) | memory | **Postgres cannot drop an enum value.** Permanent residue |
| `dormant_flag` table (0012) | **ingestion** | NOT task-owned; `task.dormant` only mirrors it. Survives |
| `memory.kind='open_loop'` (0011:19) | memory | memory-level concept, survives |

### 2.3 Entanglements — where removal is risky

| Entanglement | Risk | Evidence |
|---|---|---|
| **Deletion receipts count tasks** | `tasks_removed` sits inside the **signed, hash-chained** `counts_json` (`deletion-saga.ts:194-197,321-326,439-444`). The Zod field must stay (optional) or verification of every historical receipt breaks. The `DerivedCascade` port itself is clean — unbind `TasksCascade` and the arm disappears | high |
| **Conclusion memories** | existing memory rows carry provenance `source_type='task_conclusion'`; dropping the `task_conclusion` table orphans them and trips the integrity sweep's provenance arm (decision 0024). They must be deleted through the saga or their source rows retained | high |
| **Passport contract** | `"tasks"` is in the published manifest schema's `required` (`docs/passport-schema/manifest.schema.json:51,54`) + `tasks.schema.json` + samples. Removal = **breaking passport version bump** (decision 0029 versioning exists for this) | medium |
| **Digest composition** | port is ingestion-owned (`digest-task-port.ts`, `@Optional()` injection in `dreaming.controller.ts:24-27`) — removal is clean (lines simply vanish), but attention filters digest lines by `section==='tasks'` (`attention.service.ts:203-209`) to avoid double-counting | low |
| **Chat intents** | `detectCreateTaskIntent` + `ADOPT_TASK_PATTERNS` are deterministic regex in `query-rewrite.ts:191-272` (no prompt); handlers `chat.service.ts:845-1005`; the create-task check runs **before** the email-reply intent, so removal changes routing order | medium |
| **Attention/stats** | `AttentionService` imports `TasksEngine` non-optionally (`attention.service.ts:20`); `DashboardStatsDto.tasks`, `AttentionKind` task variants, `AttentionGroup 'tasks'` in `project/shared/src/attention.ts` | medium |
| **Retrieval depends on tasks statically** | `retrieval.service.ts:7` imports `TaskRow`; `retrieval.module.ts:16` imports `TasksModule.register()`; answer prompt's `tasks` mode | medium |
| **Demo assertions** | `entrypoints/demo/assertions.ts:50-56` raw-SQL asserts ≥3 tasks, ≥1 blocked, ≥1 dormant; 6 corpus items exist to produce tasks | low |
| **Skills** | planner has an open-loops retrieval leg (`skill-planner.ts:97-104`); proposed actions adopt via `/api/tasks/adopt` (`0034_skill_runs.sql:18-20`) | medium |
| **Audit history** | 9 `task.*` audit actions persist as historical rows (append-only table); generic renderer copes | none |
| **Migration-embedded enqueues** | 0014 and 0030 enqueue task jobs on migrate; fresh installs of a task-less 2.0 need those migrations edited or the job types tolerated as no-ops | low |

### 2.4 "Open loops" — what is worth preserving, and where it lives

1. **Memory kinds `commitment`/`open_loop`** — fully memory-owned (migration 0011, extraction
   prompts). Zero task dependency. This is the durable core of the concept.
2. **The open-loops question path** — `OPEN_LOOPS_HINT_RE` (`query-rewrite.ts:144`), retrieval mode
   `'tasks'` (`retrieval.service.ts:112-127`), answer-prompt rules. Today it reads
   `TasksEngine.listForPrincipal`; it could read deriving-kind memories with `status='active'`
   directly — no schema needed.
3. **Dormancy ("gone quiet")** — already lives entirely in ingestion (`dormant_flag`,
   `dormant-flags.ts`). `task.dormant` is a mirror. Survives intact.
4. **The attention surface** — the only user-visible "awaiting you" home. Its `quiet` group can be
   re-fed from `dormant_flag`; due-dates from `memory.valid_until` (the engine already derives
   `due` from `head.validUntil`, `tasks.engine.ts:622`).
5. **The adoption gesture** ("make this a task" — drawer, API, chat form) — the deliberate
   first-person act decision 0054 was built around; the right entry point for any 2.0 "user-owned
   follow-up" concept.
6. **Reminders** — durable state is just two nullable columns on `task` + one crontab line; would
   need rebuilding (memory-level `due_reminded_at` or a small new table).

Not worth preserving: closure/condition model judgments + their prompt families, the
conclusion-memory loop, supersession repointing, backfills, `from_uncertain`, the `/tasks` page.

---

## 3. Scope/gating model, and the per-project third dimension

### 3.1 As built

- Enum `scope('private','shared')` (migration 0001:8), TS mirror `shared/src/memory.ts:17`,
  `pgEnum` **re-declared 3×** (memory, connectors, tasks tables files). `sensitive` boolean is
  orthogonal (decision 0003).
- **8 tables carry scope**: `memory`, `file_metadata`, `note`, `email_message`, `web_page`, `task`,
  `task_conclusion`, `user_settings.default_scope`. Owner-only tables (no scope): `conversation`,
  `chat_message`, `research_run`, `skill_run`, `passport_export`, attention/user-context tables.
- **The gate is expressed in exactly two places** and everywhere else composes them:
  - SQL: `memory.store.ts:1296-1302` `visibleTo()` — `(owner=me OR scope='shared') AND sensitive-gate`
  - Qdrant: `vector-store.ts:82-91` `buildGateFilter()` — the payload-filter mirror, kept in sync
    by comment + `cross-user-scope.integration.spec.ts` (11 invariants), not by construction.
- No org predicate and no `org_id` on `memory` — cross-org isolation is a deployment boundary by
  decision 0019. (Comments in `task-visibility.ts:11` and `tasks.engine.ts:909` claiming an "org"
  gate are wrong.)
- Scope is stamped **at capture** per connector and inherited by derived memories through one
  funnel: `SourceItem.scope` → `embed-store.stage.ts:74` (`?? 'private'`). Chat stamps no scope
  (falls to default); research hardcodes `'private'`.

**The "unscoped queries unrepresentable" claim: true for `RetrievalService` (single gated method),
false for `MemoryStore`.** Nine public methods take no Principal and apply no gate
(`getManySystem`, `listBySourceSystem`, `listByKindsSystem`, `listTouchedBetween`,
`listLapsedActive`, `listQuietCommitments`, `describeSource`, `confirmedReceiptsForOwner`,
`setAuthoredByUserBySourceSystem` — `memory.store.ts:950-1253`). Documented as worker-only;
enforced by convention only.

### 3.2 Gated read paths (verified)

All ~25 memory read methods pass `visibleTo`/`buildGateFilter`: retrieval fusion, chat retrieval,
memory browser, timeline/point-in-time, digest (`getManyForPrincipal` with `includeSensitive`),
passport (`listAllForPrincipal`), skills planner (via `retrieve`), reply drafting, bulk-outdate,
context suggestions. Tasks reads are gated derived (`gateForeignTasks` → `getManyForPrincipal`).
Owner-only (`eq(ownerId, me)`, no shared arm, ~40 hand-written sites): conversations,
chat history, research runs/pages, skill runs, attention state, receipts-by-owner, email sources,
files, allowlist.

**Read paths with no scope filter (flagged):**

| # | Path | Note |
|---|---|---|
| 1 | `GET /receipts/verify` + `chainTip()` (`receipts.controller.ts:49-56,121-129`) | instance-wide chain check by design, but leaks every user's `source_id`, counts, `requested_by` to any authenticated caller |
| 2 | the 9 `MemoryStore` system methods | publicly callable from any request-path service |
| 3 | task derivation reads all owners' memories (`tasks.engine.ts:163,190,…`) | writes `task.scope` from memory it never gated |
| 4 | file download shared-arm org check = `objectKey.split('/')[0] === principal.orgId` (`files.service.ts:338`) | authz decision on a path segment, not a column |
| 5 | audit reader admits `org_id IS NULL` rows (`audit.controller.ts:52`) | 0020 ruling-6 follow-up still open — memory/tasks/reconciliation writers never stamp `org_id` |
| 6 | integrity sweep, jobs/dead-letter admin surface | cross-owner by design (AdminGuard on jobs only) |

### 3.3 Per-project blast radius (third dimension)

There is **no project concept anywhere in code** (grep: zero hits outside roadmap prose). The
closest analogue is `conversation` (migration 0031), whose own header calls it "the chat area's
workspace container" — but decision 0056's core ruling is that **knowledge deliberately crosses
threads**; per-project memory inverts that and needs a superseding owner decision first.

What must become project-aware:

| Area | Work |
|---|---|
| Schema | `project` table (new) + `project_id` on the 8 scope-bearing tables + ~8 owner-only tables (conversation, research_run, skill_run, passport_export, attention…); replace `memory_owner_scope_idx`; migrations 0001/0014/0016/0018/0021/0025/0027/0031 amended by a new one. Design choice: orthogonal nullable `project_id` (cheap) vs. widening the `scope` enum (breaks the `visibleTo` OR-shape; don't) |
| Gates | 2 edits at the gate definitions (`visibleTo`, `buildGateFilter`) — genuinely small — plus threading `projectId` through `ReadOptions/SearchOptions/MemoryFilters` and ~25 memory read methods, 8 retrieval `searchOpts` constructions, the task SQL arm, and **~40 hand-rolled owner-only predicates** that inherit nothing for free |
| Qdrant | payload field + keyword index + filter + write/mutate sites; **full reindex** (or payload backfill); integrity sweep payload-compare must learn the field or it reports every point stale |
| Reconciliation | candidate pool narrowing (`reconcile.stage.ts:304-333`) must gain a project condition or facts reconcile across projects |
| Conversations | `conversation.project_id` (or promote conversation to project) + supersede 0056 |
| Passport | published JSON Schema (2 files + samples) — **breaking version bump**; per-project vs whole-user export decision |
| Deletion | "delete a project" = new source type (the `chat_conversation` pattern); `counts_json` is inside the signed receipt chain — versioned counts schema needed |
| Dashboard | 8 aggregate calls in `attention.service.ts` + backing store aggregates + charts |
| Connectors | one choke point (`SourceItem.projectId` → `embed-store.stage.ts:74`) makes ingestion project-aware, but **6 assignment sites** must each decide *which* project (notes body, files form, email routing?!, research, conclusions, settings default) — email is the hard one: an inbound message has no project |
| MinIO | do **not** insert a key segment (`object_key` is a PK, keys parsed positionally at 4 sites, receipts reference keys) — put `project_id` in `file_metadata` + object metadata instead |
| UI | project switcher + per-project routing across ~9 pages, scope pickers, filters, API client |

**Honest sizing:** ~55–70 prod files, 2 gate edits + ~65 call-site edits, 1 full reindex, 2 broken
published contracts (passport schema, receipt counts canonical form), 1 superseding decision record.
The memory gate held up beautifully (decision 0003 paid off); the cost is everything *around* it,
and the precedent is sobering — `org_id` was exactly this migration and decision 0019 chose not to
do it.

---

## 4. Contradiction detection as implemented

**Mechanism** (decision 0010): deterministic candidate rules → versioned thresholds
(`reconcile-config.ts`, `RECONCILE_CONFIG_VERSION=1`, never bumped) → one model judge per pair →
pure survivor policy → aggregate-owned state mutation. Runs inline (pipeline stage 6) and nightly
(dreaming). Candidates: same owner AND same scope, topK 8, max 3 checks per family per fact.
Contradiction requires **all** of: similarity in [0.80, 0.93) (above 0.93 only after dedup ruled
`distinct`), byte-equal lowercased `subject_entity`, kind ∈ {fact, decision, preference,
commitment}, target status ∈ {active, user_approved}. At most **one** contradiction action per fact
per run. Prompts `reconcile_dedup/v0001` and `reconcile_contradiction/v0001` — both still at v0001
while answer reached v0006; the prompt itself instructs "when in doubt, answer compatible."

**Conservatism guards:** `user_approved` never merged/superseded; supersession requires the model's
winner to also be temporally later or it downgrades to a human-facing contradiction; relation rows
are permanent tombstones blocking re-detection; `uncertain` facts never pair; deletion lifts
contradictions first.

**Recorded numbers** (20 pairs: 11 contradiction, 9 dedup; `docs/eval/history.md` 2026-07-25 +
`eval/trust-scores/v1.1.0.json`): contradiction recall 1.000 aggregate (gate ≥0.70), precision
0.857 (6/7) — **precision is computed but not gated and not published**; supersedes **0/1** (the
single supersedes case fails and lands as a human contradiction); dedup 0.929 (hr 0.833 — below the
0.90 gate individually, masked by the aggregate). Run-to-run variance is visible in history (same
day: recall 83.3%).

**Where to strengthen:** cross-language pairing (exact-string entity match means
"Adriatic Foods"≠"Jadranske hrane"; zero mixed-language eval pairs; redaction NER is
English-only — `SPACY_MODEL=en_core_web_lg`); the 0.93 escalation hole (a `related` dedup verdict
never escalates, so high-similarity paraphrased conflicts are structurally invisible); numeric/unit
reasoning (none; one numeric case in the corpus); interval arithmetic for supersession (the 0/1
case has explicit `valid_from` on both sides and still fails); per-embedding-model threshold
calibration (0.80/0.93 silently reinterpret under bge-m3); a checked-pair ledger (`compatible`
verdicts are re-asked every night, and near-miss decisions leave no audit trace).

---

## 5. Enterprise-mapped capabilities, as-built

| Capability | As-built | Gaps |
|---|---|---|
| **Verification-before-storage** | Real and structural: independent prompt family (`verification/v0004`+batch `v0005`) judges each claim against its cited span ±240 chars; `active` only if `supported` AND not hedged, else `uncertain` (`embed-store.stage.ts:60`); omitted batch answers fail-safe to `uncertain`; verdict+span persisted per memory; agreement 0.865 published | `uncertain` is a single undifferentiated bucket (hedged-in-source vs unsupported vs unjudgeable) |
| **Temporal validity** | One predicate in one place (`memory/domain/interval.ts`, pure + SQL forms, truth-table tested); intervals set by a deterministic resolver, closed on supersession, mirrored to Qdrant payload; point-in-time + diff + `changesSince` + 3 explicit temporal retrieval modes; 4 chat eval cases pass | valid-time only (no queryable transaction-time axis); no DB overlap constraint; `valid_until` sometimes set to merge-time rather than event-time |
| **Audit logging** | One append-only table (UPDATE/DELETE-rejecting trigger), single writer `writeAudit` in-tx, 44 actions across 15 files, structural-metadata-only hygiene (decision 0025), org-gated reader with owner-only detail | **No read auditing at all**: retrieval, chat, **passport export** (full-corpus export leaves no row), file downloads, model-gateway egress, auth events (all in Zitadel's separate log), instance config changes, reconciliation "no action" decisions. No retention policy, no hash chain on audit itself (only receipts are chained), no SIEM export |
| **Identity** | OIDC-only via bundled Zitadel (userinfo validation, no local JWKS); Principal cache TTL bounds token revocation (decision 0026); default-deny guard; exactly **one enforced role** (`admin`, guarding exactly one controller — jobs); `MeDto.isAdmin` is display-gating | No SAML consumption (Caddy proxies `/saml/*` but nothing reads assertions), no SCIM, no LDAP, no role model beyond admin, no session management/forced logout, no per-endpoint MFA; BYO-IdP = federate inside bundled Zitadel |
| **Airgap** | Genuinely works: `ollama-local` preset runs all three tiers locally with boot probes; local embeddings + dimension guard + reindex; all storage in-instance; Zitadel self-hosted, no phone-home anywhere (verified: no telemetry, no analytics dep); redaction wheel baked at build; local certs default; one egress seam CI-enforced. Offline eval recorded: **24/27 chat cases vs 27/27 hosted** | research profile obviously online; image pulls (digest-pinned, but no offline bundle/`docker save` story); redaction + caddy + mail are `build:` not `image:`; hosted Mistral is the default posture |
| **Observability** | `/api/health` aggregate (pg/qdrant/minio/encryption/integrity/queue/gateway/mail) + capability registry with loud states + boot banner; pino structured logs with secret+content redaction, no stacks; jobs/dead-letter admin UI with audited retry; per-stage pipeline log | **No metrics** (no Prometheus, no counters anywhere), **no tracing/correlation IDs** (a request can't be followed HTTP→job→model call), **no alerting** (degraded health pages no one), no log shipping/retention, no historical health, no per-provider latency/token series |

---

## 6. Connector readiness

### 6.1 As built

| Connector | Ingress | Provenance | Scope | Notes |
|---|---|---|---|---|
| notes | `POST /api/notes` | `user_note` / note.id | body ?? user default | reference implementation |
| email | Haraka `hook_queue` → `POST /api/email/intake` (shared-bearer guard, SPF gate, sender routing 0031, per-user allowlist) | `email` / email_message.id; attachments become separate `file` sources | recipient's default | `authored_by_owner` at intake; **no Message-ID dedup** — double delivery absorbed downstream by reconcile |
| files | `POST /api/files` (multer) | `file` / **objectKey (a MinIO path, not a UUID)** | form ?? default | discard mode reads owner/scope from object metadata |
| chat | `ChatService.rememberMessage` — **lives in retrieval, not connectors** | `chat` / chat_message.id | **none stamped** → defaults private | a full connector by every structural measure, in the wrong module |
| web | approved `research_run` → hardened fetcher (SSRF/robots/caps) | `web` / web_page.id; provenance chains to `sent_query` | hardcoded `'private'` | only source with a fact cap (`WEB_MAX_FACTS=30`) |
| skills | not a source type — produces `web` sources + proposed actions only; engine consumes ResearchService (why it's co-located in connectors) | — | — | adoption via `/api/tasks/adopt` |

**The seam that exists:** the `SourceReader`/`SourceDeletion` port pair
(`ingestion/pipeline/source-reader.ts:46-66`, `memory/deletion-saga.ts:71-101`), registered as
hand-maintained arrays in the composition roots, dispatched by linear scan. `SourceItem` is the
entire normalized contract. The one shared write mechanic is `withTransactionalEnqueue`. Everything
above `load()` is bespoke per connector: own controller+Zod, own tables, own quota check, own
object-first-then-tx ordering, `getProcessingState` duplicated near-verbatim ×3.

### 6.2 What an external connector (Google/M365/Slack/Teams/Jira) requires

| Need | Status |
|---|---|
| Credential storage | **Zero exists.** No token table, no secret encryption helper, no refresh loop; dep-cruiser forbids OAuth clients outside identity. Deliberate (Roadmap Revision D2: "no OAuth, no CASA"). All greenfield |
| Sync/cursor state | **Zero.** `connectors/README.md:10-14` promises delta/history tokens — never implemented. No connector polls anything today |
| Outbound rate limiting | none — no token bucket, no 429/Retry-After handling; Graphile retry is not rate-aware |
| Webhook ingress | one hand-rolled precedent (email intake guard); no HMAC/replay/dedup framework, no subscription-renewal job |
| Provenance fit | `source_type` is a **hard PG enum** (irreversible `ADD VALUE` per connector) + a hardcoded-switch tax across ≥6 files (derivation rule, SourceDrawer, deletion saga, sweep, passport, pipeline fact-cap). Extends mechanically, not cleanly. 2.0 choice: text + registry, or accept the tax |
| Re-sync dedup | `job_execution` uniqueness protects job re-delivery, **not** the same external item under a new source_id. No natural-key/remote-id uniqueness anywhere (email has no Message-ID constraint; web has no URL constraint). A polling connector re-returning items = N× extract+verify+reconcile cost |

### 6.3 Task-noise (and memory-noise) risk

`firstPersonSource` (`derivation-rule.ts:30-45`) is **default-deny**: any new source_type derives
zero tasks unless someone adds a case, and the derivation traps fail the build. That protection is
real. But it only covers task *creation*:

- **Memory extraction is unconditional and source-agnostic** — the extraction prompt has no
  first-person rule; an observed Slack channel produces durable third-party memories at full volume.
- **Closure/condition judging is deliberately source-agnostic** (0054 ruling 3) — every admitted
  memory from any source is judged against open tasks: phantom-*closure* risk, per-item model cost.
- **Per-source controls barely exist**: `user_settings` has two columns; no per-connector
  enable/extraction toggle/retention/fact-budget (the web cap is a hardcoded special case). The
  email allowlist is the only per-source admission control and the right precedent to generalize
  ("which channels / which projects").
- Only the reply-draft prompt treats external content as untrusted; the extraction prompt has no
  injection defence — relevant when observed sources carry adversarial text.

Conclusion: observed connectors would not re-introduce phantom tasks; they would move the noise
into the memory corpus, model spend, and closure loop. The missing piece is a per-source
*extraction* gate — the analogue of `firstPersonSource` — which does not exist.

---

## 7. Dead, thin, superseded, duplicated

### 7.1 Dead code (verified by whole-tree symbol grep)

- **15 shared request DTOs never adopted** (`project/shared/src/*.ts` — `ChatAskRequest`,
  `NoteCaptureRequest`, 5 research requests, 3 skills requests, …): every controller declares its
  own inline Zod schema (34 of them). The "API contract" tier is a graveyard.
- Dead files/functions: `web/src/user-context.ts` (entire file; Settings inlines the same query),
  `api.ts:228 fetchDreamDigest`, `api.ts:542 fetchPassportExport`, `STATUS_CHIP`,
  `['dream-digest']` invalidation key; 8 unused `*Row` types; `reminders-config.ts` version
  contract honoured nowhere.
- **Dead HTTP route**: `POST /api/research/capture` (`research.controller.ts:42`) — web only calls
  the per-run capture; no spec exercises the route. (`docs` also cite a nonexistent
  `/api/research/search`.)
- **Barrel over-exposure**: memory exports ~90 symbols, **52 unused outside the module**;
  connectors 39/~80; ingestion 35; model-gateway 28. The "one public interface" rule is formally
  met and semantically hollow.
- Dev code in the prod image: `memory/dev-seed.ts` ships (its callers are `rm -f`'d in the
  Dockerfile); `entrypoints/demo/` (1,872 L) ships; `email-authorship-backfill` (one-shot 0030
  backfill) still registered as a recurring worker job.

### 7.2 Superseded / stale

- **CLAUDE.md is severely stale**: still says "the next session is the first coding session" and
  lists migration 0001 as the first task — the product is at v1.1.0 with 34 migrations. It also
  still describes calendar as an ingested source (dropped by Roadmap Revision D1).
- 14 of 27 prompt versions inactive (immutable by §B.7, fine, but decision 0046's header names
  versions that have since moved on).
- Legacy env expansion `COGETO_MISTRAL_MODEL_*` kept for v1 parity
  (`provider-config.ts:170-202`) — a natural 2.0 break point. Two pre-reply-triggers compat shims
  in the reply-draft action.
- The manual Research-page flow and the chat inline flow are a **permanent double implementation**
  of research orchestration (by design per 0050, but `synthesiseResearch` in the web client
  duplicates the server-side `ResearchConclusionService`).

### 7.3 Duplication (byte-level, verified)

| Duplication | Sites |
|---|---|
| Citation-marker resolver, byte-identical | `research-synthesis.service.ts:246-277` ≡ `skill-engine.ts:562-595` (+ their [W#]/[M#] builders, context preambles, prompt-complete blocks) |
| User-context/language preamble | 5 divergent idioms (chat, synthesis, skills, tasks, dreaming) |
| Zod→BadRequestException adapter | **27 identical copies** across controllers |
| Shared-scope OR-gate SQL | 3 copies (memory, tasks ×2) + ~20 hand-written owner gates; no helper |
| Eval harness skeleton (metrics/finalize/walker) | 3 near-identical harnesses + a 4th ad-hoc in `eval-chat.ts` |
| Bare-CLI bootstrap (`createModelGateway` + store options) | 6+ entrypoint files |
| Web date formatting | 3 definitions + 16 raw `toLocaleString` sites (one hardcodes `en-GB`, ignoring decision 0052) |
| Anaphora-resolution block | 3 identical copies inside `chat.service.ts` |
| en/hr strings inline in services | ~10 files, no i18n layer |

### 7.4 Modularity problems

16 non-spec files >500 lines (`memory.store.ts` 1,363; `eval-chat.ts` 1,196; `chat.service.ts`
1,154; `tasks.engine.ts` 1,045; `Settings.tsx` 972 …). `MemoryStore` has 6 distinct
responsibilities including the ungated System back doors. `ChatService` has **6 `@Optional()`
constructor params with load-bearing positional order** ("Appended LAST so positional harness
constructions keep working" — `chat.service.ts:139-141`); 8 services share this fragile
optional-DI pattern. Ambient state: `AsyncLocalStorage` usage context mutated across module lines;
in-process budget/counters (not multi-process safe). The approval `ActionDefinition.execute(tx,…)`
hands any registered action a raw transaction to the whole DB. Web: `api.ts` is one flat 623-line
file; 33 query keys are never invalidated by any mutation group. Config is *not* sprawled (one
`config.ts` funnel, env-consistency-tested) — the funnel itself is just large.

---

## 8. Test and eval inventory

### 8.1 Tests — 130 spec files (118 src + 12 web), zero e2e

| Module | Unit / integration specs | Notable invariants |
|---|---|---|
| retrieval | 9 / 11 | **cross-user-scope: 10 named scope-leak invariants** (private/shared/sensitive × read/write/Qdrant × cross-org × tasks) |
| memory | 6 / 15 | deletion saga: 7 files/29 its incl. race + per-origin cascades (email/web/conversation/upload); receipt chain |
| agents | 1 / 2 | **approval gate: 10 invariants** (worker-only, idempotent, concurrent-confirm, expiry, authz, audited) |
| connectors | 10 / 13 | mail intake guard, allowlist, authorship, thread dedup, research gate/minimise |
| tasks | 3 / 4 | derivation discipline (11), no-second-scheduler |
| entrypoints | 11 / 5 | deployment hardening, secret preflight, env consistency, demo guards |
| ingestion | 8 / 3 | extract guard, temporal resolver, reconcile, dreaming |
| model-gateway | 6 / **0** | all adapters/redaction/budget unit-only, no integration |
| identity | 5 / **0** | guards unit-only; no HTTP-layer refusal test |
| passport | 2 / 1 | **2 integration `it`s total** for the data-portability guarantee |
| infrastructure / web / shared | 2/1 · 12/0 · **0** | web specs test extracted pure models only; **16 pages, 0 render/e2e tests**; `api.ts` untested; the 3 flows the architecture doc reserves for Playwright (login, chat round-trip, deletion receipt) have no automated coverage |

### 8.2 Golden corpus and gates

108 case dirs (54 en / 54 hr; **no third language**): 76 `expected.json`
(extraction+verification — 74% synthetic user notes vs the doc's target mix; zero calendar), 20
reconcile pairs, 12 task pairs, 6 derivation traps, 27 chat cases (8 hr). Everything runs **live**
against Mistral (temperature 0) — there is no mocked eval path. **PRs run `npm run build` only**;
the live gate runs post-merge on main, only when the path filter matches and the key is present
(missing key = skip loudly, not fail).

Gate floors (`gates.json`) vs the spec doc's own floors: extraction precision gated at **0.70 vs
spec 0.85**, verification 0.75 vs 0.90 — calibrated for noise on a 36-case corpus and never
re-raised. Ungated-but-measured: task accuracies, contradiction *precision*, supersedes. The chat
coverage mean gates on a 2–4-case denominator.

### 8.3 Latest published scores (v1.1.0, 2026-07-25, mistral-default)

| Metric | en | hr | Agg | Gate |
|---|---|---|---|---|
| extraction precision | 0.846 | **0.735** | 0.789 | 0.70 (spec doc says 0.85) |
| extraction recall | 0.962 | 0.904 | 0.933 | 0.80 |
| verification agreement | 0.861 | 0.868 | 0.865 | 0.75 |
| dedup accuracy | 1.000 | **0.833** | 0.929 | 0.90 (hr under the gate, masked by aggregate) |
| contradiction recall | 1.000 | 1.000 | 1.000 | 0.70 |
| chat | — | — | 27/27 | rules + mean ≥0.65 |

Precision dropped 0.827→0.789 vs v1.0.5 (−3.8 pts; the doc's own ">2 points requires a decision
record" rule was not followed). Croatian is the consistently weak column.

**Well-guarded:** retrieval gates, deletion saga, approval machine, task derivation discipline,
email intake, reconciliation. **Exposed:** all UI (zero e2e), passport export (2 its, no audit
row, no round-trip test), digest content, skills engine/registry (no dedicated spec), workspace
isolation as a concept, model-gateway and identity at integration level, `project/shared`
(0 tests), Croatian quality, and PR-time regressions (nothing evaluates before merge).

---

## Executive summary — the three hardest things about this refactor

1. **The boundaries that matter are enforced nowhere the tool looks.** dependency-cruiser reports
   zero violations while 7 of 11 Nest modules are global, barrels re-export live Drizzle tables
   (8 infrastructure tables written from 7 modules), `entrypoints` has accreted into an undeclared
   13th bounded context with raw SQL over six modules' schemas, and the `source_type` enum welds
   every module's identity into a memory-owned migration. A 2.0 module split must first decide
   what "boundary" even means here (imports? tables? job names? DI tokens?) — the current answer
   is "imports only," and that is the least binding of the four.
2. **The task engine is the most entangled subsystem in the product, and its removal touches two
   signed public contracts.** Tasks reach the deletion receipts (inside the hash-chained
   `counts_json`), the passport manifest (`tasks` is a *required* key in the published schema),
   the digest, chat routing order, attention/stats DTOs, retrieval's static imports, demo
   assertions, 5 worker jobs, and an irreversible enum value. The open-loops *concept* worth
   keeping is already mostly outside tasks (memory kinds, dormant flags, attention) — the risk is
   entirely in the extraction.
3. **Everything conversational and connector-shaped converged into two god surfaces.**
   `connectors/` (7.9k LOC, six unrelated families, imports 8 modules) and `retrieval/chat`
   (a 1,154-line orchestrator with positional-order-load-bearing optional DI) are where every new
   feature landed after v1. Any 2.0 modularization starts by splitting these two, and both are
   guarded almost entirely by integration tests that boot the whole system — refactoring them
   safely requires the seams (chat intents, source readers, resolver ports) to become explicit
   contracts first.

## Task-removal blast radius

Removing tasks means deleting the 21-file module, 2 tables, 2 enums, 8 endpoints, 2 prompt
families, 5 worker jobs, a CLI, the Tasks page and its nav/dashboard/attention/drawer tendrils, 12
task-pair + 6 trap + 7 chat eval cases, and task sections inside 3 shared prompts — but the risk
concentrates in five places: (1) `tasks_removed` lives inside the signed, hash-chained deletion
receipts, so the field must remain optional forever or historical receipts fail verification; (2)
existing memories carry `source_type='task_conclusion'` provenance, which cannot be dropped from
the Postgres enum and whose rows must be deleted through the saga or the integrity sweep will flag
orphans; (3) the passport schema publishes `tasks` as a required manifest key — removal is a
breaking passport version; (4) `AttentionService`, `DashboardStatsDto`, retrieval's answer prompt
and static `TaskRow`/`TasksModule` imports, and the chat create/adopt intents (which run *before*
the email-reply intent, so routing order changes) all need coordinated edits; (5) demo assertions
and two migrations enqueue task jobs on fresh installs. The preservable "open loops" core —
`commitment`/`open_loop` memory kinds, the dormant-flag table, the attention surface, the
open-loops chat path, and the adopt gesture — already lives outside the tasks module or can be
re-fed from memory rows (`valid_until` as due-date), which makes a clean extraction genuinely
feasible; only reminders would need rebuilding from scratch.

## Per-project-memory blast radius

The gate itself is cheap — scope is enforced in exactly two functions (`visibleTo` in
`memory.store.ts:1296` and its Qdrant mirror `buildGateFilter` in `vector-store.ts:82`), so a
third dimension costs two edits there — but everything around it is expensive: a new `project`
table plus `project_id` on ~16 tables (8 scope-bearing, 8 owner-only), ~65 call-site edits
threading the filter through 25 memory read methods and ~40 hand-rolled owner-only predicates that
inherit nothing, a full Qdrant reindex plus integrity-sweep awareness, project narrowing in
reconciliation (or facts merge across projects), six connector assignment sites that must each
decide *which* project (email inbound being the unsolvable one — a forwarded message names no
project), a breaking version of the published passport schema, a versioned change to the signed
receipt `counts_json` canonical form, dashboard/attention aggregates, and a project switcher
across ~9 UI pages. Realistic footprint: 55–70 production files. Two design decisions gate the
work before any code: whether `project_id` is an orthogonal nullable column (recommended) rather
than a widened scope enum, and the fact that per-project memory *inverts decision 0056* ("memory
is the continuity, conversations are workspaces — knowledge crosses threads") — the conversation
container is the natural thing to promote or parent, but that needs a superseding owner decision.
The sobering precedent: `org_id` was exactly this migration, and decision 0019 chose deployment
isolation instead.

## Surprises vs. what the docs claim

1. **CLAUDE.md still says the first coding session hasn't happened** ("scaffolding is complete;
   the next session is the first coding session") and lists migration 0001 as the next task — the
   product is at v1.1.0 with 34 migrations. It also still names calendar as an ingested source.
2. **"Unscoped queries are unrepresentable" is only true for `RetrievalService`** — `MemoryStore`
   exports 9 ungated System methods callable from any request-path service; the invariant is
   convention, not type system.
3. **dependency-cruiser's rule 4 comment promises barrel re-exports are blocked; they are not** —
   `infrastructure/index.ts` re-exports 8 live tables that 7 modules write. Also `passport` is
   simply missing from `DOMAIN_MODULES` (one-word config bug).
4. **`connectors/README.md` promises sync-state and encrypted token tables** — neither exists
   anywhere; no connector polls anything.
5. **The live eval gate floors are far below the spec doc's own thresholds** (precision 0.70 vs
   0.85) and no eval of any kind runs on pull requests; the v1.1.0 precision drop of 3.8 points
   breached the doc's ">2 points needs a decision record" rule without one.
6. **Audit logging has zero read coverage** — most surprisingly, a full Memory Passport export
   writes no audit row at all, in a product whose category is verifiable memory.
7. **Comments overstate the security posture in places**: two task files claim an "org" gate that
   does not exist (0019 made it a deployment boundary); the file-download shared-arm org check is
   a string comparison on an object-key path segment.
8. **The receipts-verify endpoint is instance-wide by design** and exposes every user's source ids
   and counts to any authenticated user — defensible single-tenant, but at odds with how carefully
   everything else is gated.
9. **`eval-chat.ts` (1,196 lines, raw SQL into six modules) lives in the composition root** and
   demo/dev-seed code ships in the production image.
10. **The single supersedes eval case fails (0/1)** and contradiction *precision* is measured but
    neither gated nor published on the trust page — the published trust score shows only the two
    metrics that look best (dedup, recall).
11. **Chat capture stamps no scope** on its SourceItem (falls to the `'private'` default silently),
    and chat-the-connector lives in `retrieval/`, not `connectors/`.
12. **Zero TODO/FIXME comments in ~75k lines** — unusually clean by that measure, which makes the
    structural debt (god files, global modules, duplicated gates) easy to miss from inside.
