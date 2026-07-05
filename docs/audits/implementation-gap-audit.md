# Cogeto — Implementation Gap Audit

**Date:** 2026-07-04 · **Method:** read-only comparison of the binding docs
(Addendum §A/§B, AGENTS.md, glossary, decisions 0001–0007, sessions S1–S3.5) against
the code at HEAD. Every claim below carries a `file:line` or grep. Sessions 1–3.5 are
complete. **Revised plan referenced for severity:** S4 = files + deletion saga +
approvals + dreaming; S4.5 = tasks + temporal + shared-scope + chat-capture; S5+ =
Ana sandbox + connectors + productization.

## Executive summary

The core memory spine is real and honest: capture → extract → verify → embed → gated
hybrid retrieval → chat → governance dashboard all work end-to-end, with the scope /
sensitive hard gates enforced in SQL and Qdrant payload filters (`memory.store.ts`,
`vector-store.ts`), supersession that never destroys history, and a live eval harness.
Roughly **five of the eleven v1 Verifiable-Memory features are missing entirely**, all
downstream of three stubs. The three most consequential gaps: **(1) the deletion saga
+ receipts (§A.7/§B.1) do not exist** — `DeletionSagaStub` throws, no API route, and
`deletion_receipt` + `file_metadata` tables have zero writers; **(2) the approval state
machine (§A.8) does not exist** — the `agents` module is an empty `@Module({})`, no
confirm endpoint, no worker executor, `approval` table dead; **(3) reconcile (stage 6)
is a pass-through stub** — so dedup, contradiction detection, consolidation/dreaming,
supersession-by-reconciliation, and the nightly sweep are all absent, and the
`contradicted` status is therefore unreachable at runtime. All three are covered by the
revised plan (S4). **What the revised plan does NOT appear to cover:** redaction mode
(§B.8, tagged v1); MinIO server-side encryption (§A.9, tagged v1 — and `.env.example`
already claims "encrypted file bytes" falsely); scaling the golden set toward the
50-per-language target (en=19, hr=8 today) and the public trust-score page + compliance
one-pager (§B.4/§B.10, v1/launch). The build is otherwise clean and internally
consistent with its own session logs — this is disciplined partial delivery, not drift.

---

## Module state table

| Module | State | Implemented responsibilities | Missing responsibilities | Evidence |
|---|---|---|---|---|
| **memory** | FUNCTIONAL | gated reads (`getForPrincipal`/`list`/`getMany`/`getChain`), aggregate transitions, supersession, edit, review-reject, vector/FTS/entity search, reindex, two-store payload sync | deletion saga (stub throws); `file_metadata`/`deletion_receipt` never written; `content_embedding_ref`, `valid_from/until` stored but never queried | `memory.store.ts:109-115` (stub), `:200-665`; `tables.ts:69,79` |
| **ingestion** | PARTIAL | stages 1–5 real (ingest/chunk/extract/verify/embed+store), temporal resolver, admission rule, eval harness, verification read endpoint | **stage 6 reconcile = stub**: dedup, contradiction, consolidation, interval maintenance by reconciliation | `reconcile.stub.ts:10-16`; `pipeline.service.ts:106-107` |
| **retrieval** | FUNCTIONAL | hybrid RRF fusion, §A.5 status multipliers, entity-profile mode, project widening, conversational query rewrite, chat SSE + persistence, citations | **temporal query mode** (lift `outdated`/`replaced`, §A.5/§B.2) | `retrieval.service.ts:37` (only `default`/`entity_profile`); `fusion.ts:12-13` "not in v1 retrieval" |
| **agents** | EMPTY SHELL | approval table + enum schema only | entire approval state machine, confirm endpoint, worker executor, audited transitions | `agents.module.ts:8` (`@Module({})`); `persistence/tables.ts:18` |
| **connectors** | PARTIAL | notes capture (transactional), source reader, note status/read | calendar + email connectors (§A.11); OAuth callbacks/sync (0003 r4) | `connectors/` has only `notes.*`; no oauth/calendar/email files |
| **tasks** | EMPTY SHELL | none — comment only | Task entity, open loops, reminders, digest, "what did I promise/commit to" | `tasks.module.ts:8` (`@Module({})`); `index.ts` re-exports the shell |
| **identity** | FUNCTIONAL (seam) | bearer guard, Zitadel userinfo → Principal, `/api/me`, request-scoped principal | JWKS validation (userinfo used instead — sanctioned S1-A); **no tests** | `identity/*.ts`; no `*.spec.ts` in module |
| **model-gateway** | FUNCTIONAL (seam) | complete, completeStream, extractStructured (+retry), embed (batched), tiers, retry/backoff, prompt loader + registry | **no dedicated test** (exercised transitively) | `mistral.gateway.ts`, `prompt-loader.ts`; no `*.spec.ts` |

---

## 1. Placeholders and stubs

**1.1 — BLOCKER→EXPECTED GAP (S4): Deletion saga is a throwing stub.**
`DeletionSagaStub.requestDeletion()` throws `NotImplementedException('deletion saga
arrives in Session 4')` — `memory.store.ts:109-115`. No `@Delete` route exists anywhere
(`memories.controller.ts`/`notes.controller.ts` route inventory has zero delete verbs).
The saga is the one path to hard-delete (§A.7); source-level forgetting is impossible
today.

**1.2 — BLOCKER→EXPECTED GAP (S4): Reconcile stage 6 is pass-through.**
`reconcileStub()` logs `implemented: false` and returns its input unchanged —
`reconcile.stub.ts:10-16`, called at `pipeline.service.ts:106-107`. No dedup,
contradiction, consolidation, or reconciliation-driven supersession runs.

**1.3 — EXPECTED GAP (S4): agents module empty shell.** `agents.module.ts:8` is
`@Module({})` with a doc comment; no provider, controller, or service. The approval
state machine (§A.8) has no implementation.

**1.4 — EXPECTED GAP (S4.5): tasks module empty shell.** `tasks.module.ts:8` is
`@Module({})`; `tasks/index.ts` exports only the shell. No Task, open-loop, reminder,
or digest code exists.

**1.5 — Placeholder grep result (src, excl. node_modules):** the only hits are the two
sanctioned stubs above plus benign framework strings — `NotImplementedException` in
`memory.store.ts` (deletion stub + "constructed without a vector store" guard at `:575`)
and stub comments. No stray `TODO`/`FIXME`/`HACK`/"coming soon" in application code.
Grep: `TODO|FIXME|HACK|placeholder|stub|not implemented|coming soon` → 4 app files, all
accounted for.

**1.6 — Frontend nav/routes.** Enabled and real: Dashboard, Memories, Chat, Review,
System (`Nav.tsx:3-9`, `App.tsx:16-24`). Disabled placeholders: **Forgotten, Settings**
(`Nav.tsx:10` `UPCOMING`, `disabled title="Coming in a later session"` `:37-48`) — both
expected. `Dashboard.tsx:9-12` is a landing shell (StatusPanel + a dashed "arrive with
their vertical slices" note); the real governance surface is `Memories.tsx` (58 lines) +
`MemoryDrawer.tsx`. `Review.tsx:125` handles only `status: 'uncertain'` — the amber queue
— consistent with the glossary (Forgotten/other states not yet surfaced). No route leads
to a broken/static-data view.

**1.7 — Status `contradicted` is unreachable at runtime.** Only the `reconciliation`
actor may set it (`transition.ts:30`), and reconciliation is stubbed (1.2). So the enum
value exists, is transition-legal, but no code path writes it. EXPECTED GAP (S4).

## 2. Built but unused

**2.1 — Object storage never touched.** Grep for `minio|putObject|getObject|bucket|s3`
in `project/src` returns **zero** application read/writes; `s3Url` is consumed only by
the health probe (`health.controller.ts:31`). `file_metadata` has zero writers
(`grep file_metadata` → only the table def `memory/persistence/tables.ts:69`). No upload
path exists. EXPECTED GAP (S4 "files") — but see 3.9 (SSE).

**2.2 — `deletion_receipt` table + `receipt_status` enum: schema only, no writer/reader.**
`grep receipt` → enum `tables.ts:29`, table `tables.ts:79`, and the stub's return type
only. EXPECTED GAP (S4).

**2.3 — `approval` table + `approval_status` enum: schema only.** `agents/persistence/
tables.ts:9-30`; no query anywhere reads or writes it (the `approve` hits in
`memories.controller.ts:132` are the *memory* review verdict — a different mechanism).
EXPECTED GAP (S4).

**2.4 — `audit_log` is write-only.** Many writers via `writeAudit` (`memory.store.ts`
×6, `worker-tasks.ts:27`, `jobs.controller.ts:71`); **no reader** — no endpoint, service,
or UI selects from it (`grep 'from(auditLog'|select.*audit` → none). The append-only
trigger works (`0001…sql`), but the audit trail is not surfaced anywhere. UNPLANNED GAP
(no session names an audit-log view; §A.8/§B.1 imply one).

**2.5 — Columns stored but never queried.** `content_embedding_ref` — unused by design
(0005 ruling 3), point id = memory id. `valid_from`/`valid_until` — written by
`insertFact`/`supersede` and copied to the Qdrant payload, but no query filters or reads
them for answers; time-travel/temporal retrieval would be their first consumer (absent,
3.1). `superseded_by` **is** traversed (`getChain` `memory.store.ts:167-196`) — used.

**2.6 — `source_type` enum values `email`, `calendar_event`, `file` never used**;
`chat` defined as a provenance target (`retrieval/persistence/tables.ts:7`) but **no
memory is ever created with `source_type='chat'`** (see 3.10). Only `user_note` is
written (pipeline admission). EXPECTED GAP (connectors S5+, chat-capture S4.5).

**2.7 — `scope='shared'` is never written.** The gate reads it (`memory.store.ts:603`,
`vector-store.ts:73`) but no capture/edit path sets `shared` — pipeline admits
`scope='private'` only, and `createFromFact` (the only scope-taking creator) has **zero
non-test callers** (`grep createFromFact` → all hits are `*.spec.ts`). EXPECTED GAP
(shared-scope S4.5).

**2.8 — Prompt files on disk not registered at boot.** Worker registers extraction/v0002,
verification/v0002, answer/v0002, query_rewrite/v0001 (`worker.ts:40`, `prompt-versions.ts:15`,
`answer-prompt.ts:9`, `query-rewrite.ts:14`). On disk but **not** in the boot registry:
`smoke/v0001` (loaded only by `gateway-smoke.ts:27`), `eval-coverage/v0001` (loaded only
by `eval-chat.ts:196`), and the superseded `extraction/v0001`, `verification/v0001`,
`answer/v0001`. HYGIENE — expected (superseded/tool-only), but the registry does not
reflect the full prompt corpus.

**2.9 — Compose services/profiles defined but inert.** `demo-placeholder` and
`redaction-placeholder` are busybox `echo`s gated behind profiles `demo`/`redaction`
(`docker-compose.yml:260-271`) — no real service. `MINIO_ROOT_USER/PASSWORD`,
`ZITADEL_*` env vars are consumed by their containers, not app code (correct).

**2.10 — Env var drift.** Read in code but **absent from `.env.example`**:
`COGETO_MIGRATIONS_DIR`, `COGETO_PROMPTS_DIR` (both have code defaults). In
`.env.example`/compose but unread by app: none material. HYGIENE.

**2.11 — Frontend API client.** All exported functions in `web/src/api.ts` have a
consumer (e.g. `markMemoryOutdated` → `MemoryDrawer.tsx:98`). No dead client functions
found.

### Unused inventory (compact)

| Kind | Item | Status | Evidence |
|---|---|---|---|
| Table | `file_metadata` | no reader/writer | `tables.ts:69` only |
| Table | `deletion_receipt` | no reader/writer | `tables.ts:79` only |
| Table | `approval` | no reader/writer | `agents/…/tables.ts:18` |
| Table | `audit_log` | write-only (no reader) | writers ×8; 0 selects |
| Column | `memory.content_embedding_ref` | unused (by design) | 0005 ruling 3 |
| Column | `memory.valid_from` / `valid_until` | stored, never queried for reads | no temporal query |
| Enum val | `source_type.email/calendar_event/file` | never written | `tables.ts:25-27` |
| Enum val | `source_type.chat` | provenance target, never written | 3.10 |
| Enum val | `memory_status.contradicted` | never set (reconcile stubbed) | `transition.ts:30` |
| Enum | `receipt_status`, `approval_status` (all) | tables dead | 2.2, 2.3 |
| Enum val | `scope.shared` | read by gates, never written | 2.7 |
| Env var | `COGETO_MIGRATIONS_DIR`, `COGETO_PROMPTS_DIR` | read, not in `.env.example` | 2.10 |
| Compose | `demo` / `redaction` profiles | placeholder echoes | compose:260-271 |

## 3. Promised but unimplemented

**3.1 — §A.5 temporal retrieval mode — ABSENT.** `RetrievalMode = 'default' |
'entity_profile'` (`retrieval.service.ts:37`); no path lifts the `outdated`/`replaced`
exclusion. `fusion.ts:12-13` explicitly: "temporal queries will lift that exclusion when
time-travel lands (§B.2 — not in v1 retrieval)." EXPECTED GAP (S4.5 temporal).

**3.2 — §A.9 extract-and-discard — ABSENT.** No per-upload flag / per-user default;
`grep extractAndDiscard|discardOriginal` → 0. Tied to file upload (absent). EXPECTED GAP
(S4 files).

**3.3 — §A.7 deletion saga + §B.1 receipts — ABSENT.** See 1.1, 2.1, 2.2. No saga, no
receipt writer, no nightly sweep, no Forgotten section. EXPECTED GAP (S4).

**3.4 — §A.8 approval state machine — ABSENT end to end.** See 1.3, 2.3. No `draft →
pending_approval → approved → executed` transitions, no authenticated confirm endpoint,
no worker executor. EXPECTED GAP (S4).

**3.5 — Nightly jobs of any kind — ABSENT.** No scheduler/cron: `grep nightly|cron|
schedule|sweep|dreaming|consolidat` in `project/src` → only comments referencing the
future §A.7 sweep and the `consolidation` transition actor (`transition.ts:32`). No
consolidation job, no dreaming, no reconciliation sweep. EXPECTED GAP (S4 dreaming).

**3.6 — Part B status:**

| Feature | Tag | Status | Built in |
|---|---|---|---|
| B.1 Deletion receipts | v1 | **NOT STARTED** | — (S4) |
| B.2 Time-travel memory | schema v1 / UI v1.x | **PARTIAL** — schema (`valid_from/until`, `superseded_by`) + chain UI exist; temporal *retrieval* and diff view absent | S1-B/S3-B |
| B.3 Self-verifying extraction | v1 | **DONE** | S2-A/S3.5-B |
| B.4 Published trust score | harness v1 / page launch | **PARTIAL** — harness + golden set exist; CI gate OFF, no public page, corpus below target | S2-B/S3.5-A |
| B.5 Memory Passport | v1.x | **NOT STARTED** | — |
| B.6 Dreaming digest | v1.x | **NOT STARTED** | — |
| B.7 Versioned public prompts | v1 | **DONE** — numbered artifacts + registry + immutability check | S1-B→S3.5-B |
| B.8 Redaction mode | v1 | **NOT STARTED** | — |
| B.9 Ana sandbox | v1 early | **NOT STARTED** — `demo` profile is a placeholder | — (S5+) |
| B.10 Compliance one-pager | v1 | **NOT STARTED** | — |

**3.7 — Glossary-term mechanism check** (expectation from the prompt confirmed, with
corrections). ABSENT (no mechanism): `dreaming`/dreaming digest card, `deletion receipt`,
`Forgotten`, `Memory Passport`, `open loops`, `digest`, `redaction mode`, `Ana sandbox`,
`time-travel memory` (temporal retrieval half). Grep for `Passport|dreaming|sandbox|
redaction|open loop|Forgotten|digest` in src/web → only incidental hits: a crypto
`.digest()` (`prompt-loader.ts:35`, `pkce.ts:16`), the logger "Redaction rule" comment
(`logger.ts:6`), a `tasks.module.ts:4` doc comment listing "open loops", and the
`Forgotten` nav label (`Nav.tsx:10`, `Dashboard.tsx:11`). **Correction to the
expectation:** `deletion receipt` schema *does* exist (unused, 2.2) and time-travel is
*partially* present (validity schema + supersession chain), so those two are "schema
without mechanism," not wholly absent.

**3.8 — Scope-doc day-one job ("what did I decide, promise, commit to, what's open").**
**Half answerable today:** "what did I decide" — chat retrieval works over captured
decision-kind notes (`chat.service.ts`, `retrieval.service.ts`). **Not answerable:**
"what did I promise/commit to and what is still open" — this is the `tasks` module's
open-loops/digest job, which is an empty shell (1.4). So the commitment/open-loop half
is structurally impossible until S4.5.

**3.9 — §A.9 MinIO server-side encryption — NOT CONFIGURED.** The `minio` service
(`docker-compose.yml:196-209`) sets only root creds + a health check; no KMS/KES,
`MINIO_KMS_*`, or default-encryption config. `minio-init` (`:126-138`) creates the
bucket with no encryption policy. Yet `.env.example` labels the section "MinIO
(encrypted file bytes, S3 API)" — currently false. UNPLANNED GAP (no session or the
revised plan names at-rest encryption; S1-A flagged it as a provisioning concern and it
is still open; becomes load-bearing the moment S4 file upload lands).

**3.10 — Chat-derived memories — ABSENT.** `chat_message` rows persist
(`chat.service.ts`, `retrieval/persistence/tables.ts`), and `source_type='chat'` exists
as a provenance target, but **no path creates a memory from a chat statement**:
`createFromFact` (the only private-scope creator) is called from tests only (2.7), and
the chat controller does retrieve+answer with zero enqueue (S3-A: "nothing is
enqueued"). EXPECTED GAP (S4.5 chat-capture).

**3.11 — Shared scope / org second-user flow — ABSENT.** No capture or upload path lets
a user choose `shared` (2.7); no org/second-user invitation or membership flow exists in
code. EXPECTED GAP (S4.5 shared-scope).

**3.12 — Redaction mode (§B.8) — ABSENT.** No CPU NER (Presidio/GLiNER) sidecar,
pseudonymization, or re-hydration; `grep NER|Presidio|GLiNER|redact` → only the pino
log-redaction comment. The `redaction` compose profile is a placeholder (2.9). **UNPLANNED
GAP** — tagged `[v1]` in the Addendum but named in none of S4/S4.5/S5+.

## 4. Test and eval coverage gaps

**4.1 — Modules with zero tests:** `agents` (shell), `tasks` (shell), `identity`,
`model-gateway`. Identity and model-gateway are real, functional seams exercised only
transitively — no dedicated spec (`find … -name '*.spec.ts'` lists none in those dirs).

**4.2 — AGENTS.md non-negotiables, walked:**

| Invariant | Test? | Evidence |
|---|---|---|
| Scope-leak unrepresentable (§A.4) | ✅ | `scope_gate`/`fts_gated`/`entity_gated`/`vector_search_gated` in `memory/*.spec.ts` |
| Sensitive hard gate (0003 r3) | ✅ | `sensitive_gate`, `sensitive_toggle_two_store` |
| Status transitions owned by aggregate | ✅ | `transition.spec.ts` (full matrix) |
| Idempotent jobs + outbox (§A.3) | ✅ | `queue.integration.spec.ts` (transactional_enqueue, idempotent_job, worker_retry) |
| Two-store safety (§A.4) | ✅ | `two_store_write_safe`, `reindex_faithful` |
| **Deletion cascade (§A.7)** — DoD gate | ❌ | saga stubbed; no cascade test exists |
| **Approval gate (§A.8)** | ❌ | no approval machine, no test |
| **Golden-set eval CI gate (§B.4)** | ❌ | harness runs manually; not in CI (5.x) |
| Self-verifying extraction (§B.3) | ✅ | `admission_rule`, `abstention`, harness verification agreement |

The three ❌ are the named DoD gates CLAUDE.md lists as required "once they exist" —
consistent with S4 being where they land.

**4.3 — Golden set vs the §B.4 50-per-language target.** en = **19** cases
(`en-0001`…`en-0019`), hr = **8** cases (`hr-0001`…`hr-0008`); chat suite = 3
(`who_is_ana`, `atlas_scope`, `nothing_on_record`). Both languages are **well below** the
50-per-language target. UNPLANNED GAP (no session commits to scaling the corpus; the
public trust score publishes exactly these numbers).

**4.4 — Eval task types with zero cases (features absent).** Golden `expected.json`
carries `expected_relations: []` and no `contradiction`/`dedup`/`pair` fields
(`grep contradict|dedup|task_type|pair` in `project/eval` → 0). The harness scores only
precision, recall, verification-agreement (`eval-harness.ts:154-159`) — **not** dedup
accuracy or contradiction-detection precision/recall, which §B.4 lists. Both are zero
because reconcile (1.2) does not exist. EXPECTED GAP (S4).

**4.5 — Croatian verification/v0003 queued but not built.** S3.5-B closes flagging hr
verification agreement stuck at 57.1% and queues `verification/v0003` with Croatian
contrast examples "for Session 4." Not present on disk. EXPECTED GAP (S4).

**4.6 — CI gate defined-but-not-enforced.** `.github/workflows/ci.yml` runs lint →
boundaries → build → test only. **No `npm run eval` / eval-gate step** — so §B.4's "prompt
or model changes that regress the golden set fail the build" and CLAUDE.md's DoD
golden-set gate are **not enforced in CI**. Decision 0005 ruling 5 explicitly defers this
to Session 4. EXPECTED GAP (S4), but currently a real hole: prompt regressions cannot
fail the build.

## 5. Hygiene findings (brief)

- **5.1 — Dependencies:** all `project/src` runtime deps import-scan clean. Apparent
  zero-import deps are framework-required, not dead: `@nestjs/platform-express` (Nest HTTP
  adapter), `reflect-metadata` (side-effect import, `app.ts:1`/`worker.ts:1`), `rxjs`
  (Nest peer). No genuinely unused runtime dependency found.
- **5.2 — `.env.example` mislabels MinIO** as "encrypted file bytes" while no SSE is
  configured (3.9) — doc drift that hides a real gap.
- **5.3 — Env drift:** `COGETO_MIGRATIONS_DIR`/`COGETO_PROMPTS_DIR` read in code, absent
  from `.env.example` (2.10). Harmless (defaults) but undocumented.
- **5.4 — Session-log fidelity:** the S1–S3.5 logs match reality closely (stub locations,
  migration numbers 0001–0008, prompt versions, test names all verified). The decision/
  migration numbering-offset caveats in the logs are accurate. No material drift between
  `docs/sessions/` and code.
- **5.5 — Prompt registry** does not include tool-only/superseded prompts on boot (2.8);
  cosmetic.
- **5.6 — No duplicated cross-module logic** observed; entity/name handling is centralized
  (`entity-profile.ts`, `query-entities.ts`), citations in `@cogeto/shared/citations`.

---

## Addendum B.1–B.10 status (summary)

See the table in §3.6. DONE: B.3, B.7. PARTIAL: B.2 (schema/chain yes, temporal/diff no),
B.4 (harness yes, gate/page/scale no). NOT STARTED: B.1, B.5, B.6, B.8, B.9, B.10.

## Glossary-term mechanism status (summary)

| Term | Mechanism exists? |
|---|---|
| Reconciliation | ❌ stub | 
| Time-travel memory | ⚠️ schema only (no temporal retrieval) |
| Deletion saga / receipt | ❌ (schema only) |
| Forgotten | ❌ |
| Dreaming / dreaming digest card | ❌ |
| Digest / open loops | ❌ (tasks shell) |
| Approval state machine | ❌ (agents shell) |
| Audit log | ⚠️ write-only, no reader |
| Redaction mode | ❌ |
| Memory Passport | ❌ |
| Ana sandbox | ❌ (placeholder) |
| Hybrid retrieval / RRF / status multiplier / hard gate / reindex | ✅ |
| Verification pass / prompt version / golden set / eval harness / trust score | ✅ (score not published) |

---

## Recommendations

**Add to S4 (already scoped — confirm coverage):**
1. Deletion saga + receipts + Forgotten section + nightly sweep (§A.7/§B.1) — unblocks
   `file_metadata`/`deletion_receipt`, adds the cascade DoD test (4.2).
2. Approval state machine + confirm endpoint + worker executor (§A.8) — unblocks
   `approval` table, adds the approval-gate test.
3. Reconcile stage 6: dedup + contradiction + consolidation/dreaming — unblocks the
   `contradicted` status, dedup/contradiction eval cases (4.4), and the dreaming digest.
4. Turn the CI eval gate ON (`npm run eval` step + thresholds) (4.6); add
   `verification/v0003` Croatian contrast examples (4.5).
5. An audit-log reader/view surface (2.4) — the transitions are recorded but invisible.

**Add explicitly to the plan (NOT clearly covered today):**
6. **Redaction mode (§B.8, v1)** — currently in no session; decide S-number.
7. **MinIO SSE / at-rest encryption (§A.9, v1)** — configure before S4 file upload ships;
   fix the false `.env.example` label now (3.9, 5.2).
8. **Golden-set scaling toward 50/language + trust-score public page + compliance
   one-pager (§B.4/§B.10)** — needed for the "published" half of verifiable memory.

**Safe to delete / low-risk cleanup:**
9. Nothing should be deleted — every table/enum/column flagged unused is a contractual
   commitment (0003 ruling 1) with a scheduled consumer. The only true cleanup is doc:
   correct the `.env.example` MinIO label (5.2) and document
   `COGETO_MIGRATIONS_DIR`/`COGETO_PROMPTS_DIR` (5.3). (Report-only — not changed here.)
