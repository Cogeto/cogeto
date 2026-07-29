# Cogeto: repository hygiene audit

**Date:** 2026-07-28 · **Tree:** `main` @ `fa71a25` (post v1.1.0) · **Read-only. Nothing was changed, moved, or deleted.**

Method: full file inventory (`git ls-files`), inbound-reference grep for every deletion candidate,
unused-export sweep across `project/src`, `project/web`, `project/shared`, dash census over all
markdown and all string literals, and a comment-tag census over every `.ts`/`.tsx` file.
Counts are grep-verified, not estimated.

**Out of scope by instruction (working machinery, never proposed for deletion):** `CLAUDE.md`,
`AGENTS.md`, `docs/engineering-workflow.md`, `docs/eval-golden-set.md`, `project/prompts/**`,
`project/eval/**`, `.github/**`, `eslint.config.mjs`, `.dependency-cruiser.cjs`. Three of these
appear in bucket 3 for trimming only.

Baseline: 100 markdown files outside `project/eval`, 26,192 markdown lines, 60 decision records,
28 session logs, 22 feature notes, 7 audits.

---

## 1. DELETE

Verified: no inbound reference from any file that survives this audit.

| # | Path | Lines | Reason |
|---|---|---|---|
| 1 | `docs/Cogeto-Post-v1-Backlog.md` | 285 | Every priority in it is marked **DELIVERED**; zero inbound references anywhere in the tree; `Cogeto-V2-Plan.md` is the live plan. |
| 2 | `docs/notes/dependabot-triage.md` | 399 | One-shot triage of PRs #101 to #115, all resolved; zero inbound references. |
| 3 | `docs/notes/task-removal.md` | 89 | Working note for delivered V2.0 items 3.1/3.2; the binding record is decision 0060; zero inbound references. |
| 4 | `docs/notes/task-conclusions.md` | 32 | Documents decision 0037, **superseded in full** by 0060; only inbound reference is item 1. |
| 5 | `docs/notes/chat-create-task.md` | 31 | Documents decision 0038, **superseded in full** by 0060; only inbound reference is item 1. |
| 6 | `docs/notes/task-derivation.md` | 84 | Documents decision 0054, **superseded in full** by 0060; only inbound reference is item 1. |
| 7 | `docs/notes/time-travel-ui.md` | 141 | Delivered-session working note (O5-A); zero inbound references; the surface is covered by decision 0012 and `docs/design/README.md`. |
| 8 | `docs/notes/web-research-core.md` | 148 | Part A working note; only inbound reference is item 1; content is fully carried by decisions 0042/0043 and the Part B note (which the README links). |
| 9 | `docs/notes/conversations.md` | 64 | Delivered P6.9 working note; only inbound reference is item 1; binding record is decision 0056. |
| 10 | `docs/notes/dashboard-notifications.md` | 81 | Delivered Priority 2 working note; inbound references are item 1 and one code comment in `project/shared/src/attention.ts` (drop the pointer, keep the sentence). |
| 11 | `docs/sessions/doc-sync-roadmap-revision.md` | 79 | One-shot doc-sync report; zero inbound references. |
| 12 | `docs/notes/surface-polish.md` | 132 | Delivered P6.8 working note; the three inbound references (`docs/design/README.md:133`, decisions 0048/0049, `theme-contrast.spec.ts`) all cite it as a *record of what was done*, not as a rule; the rules live in 0048/0049. |

### Dead code (grep-verified: zero call sites outside the definition)

| # | Path | Symbol | Reason |
|---|---|---|---|
| 13 | `project/web/src/components/ui.tsx:80` | `DormantBadge` | Exported component, never rendered anywhere. |
| 14 | `project/web/src/components/status.ts:51` | `STATUS_CHIP` | Exported map, never read. |
| 15 | `project/web/src/components/status.ts:87` | `dueLabel` | Exported helper, never called; due-date labelling died with the task subsystem. |
| 16 | `project/web/src/api.ts:224` | `fetchDreamDigest` | Exported client, never called; no UI surfaces the dreaming digest. |
| 17 | `project/web/src/api.ts:496` | `fetchPassportExport` | Exported client, never called. |
| 18 | `project/src/entrypoints/trust-scores.ts:21,94` | `DEFAULT_MODELS`, `TrustConfiguration` | Exported but unreferenced; the publish script builds its own config. |
| 19 | `project/src/ingestion/domain/candidate-fact.ts:98,112` | `VerificationOutput`, `VerificationBatchOutput` | Exported Zod-inferred types, never imported. |

Verified **not** dead and deliberately left alone: the `*Row` type exports in each module's
`persistence/tables.ts` (`UserSettingsRow`, `EmailMessageRow`, `AppUserRow`, `ChatMessageRow`,
`DormantFlagRow`, `VerificationResultRow`, `EmailAttachmentRow`, `EmailRefusalRow`). Each table
declares its row type as a uniform convention; removing only the currently-unimported ones would
make the convention inconsistent for no gain.

### Not findings (checked, clean)

`.DS_Store` and `.idea/` are present on disk but **untracked and correctly gitignored** (`.gitignore:4,6`).
Nothing to delete from the repository. Every file in `assets/brand/` and `docs/assets/` has at
least one reference (`assets/brand/README.md` is the catalogue and counts as the reference for the
five variants no code uses; that is the intended purpose of a brand asset set). All five files
under `scripts/` are referenced by a workflow, `package.json`, or a doc. `project/services/redaction/app/__init__.py`
is empty on purpose (Python package marker).

---

## 2. MOVE-TO-TRASH

Deletion is probably right but not certain, or an inbound reference needs a small edit first.
Nothing here is deleted by the follow-up; each moves to `trash/<original relative path>` with a manifest.

| # | Path | Lines | Reason | What inbound references need |
|---|---|---|---|---|
| 1 | `docs/sessions/` (27 files after item 1.11) | 3,014 | Per-session engineering logs: pure process archaeology, superseded by the decision records they produced. | Drop the `docs/README.md:79` index entry; inline the two rulings that `docs/decisions/0007.md:6,12` cites by session path. Leave the dated published audits (`launch-platform-audit.md:307,327`, `implementation-gap-audit.md:311`) and `docs/eval/history.md:158` untouched: a dated record may name a directory that later went away. |
| 2 | `docs/handoff/` (3 files) | 265 | Frozen inter-session contracts for work completed a year of releases ago; the task handoff (`F3-tasks.md`) governs a subsystem that no longer exists. | Seven decisions (0011, 0013, 0014, 0016, 0018, 0024, 0028) quote a handoff section **as binding authority** ("the frozen F1 handoff §3 wins"). Each such sentence needs the quoted constraint inlined before the handoff files move. |
| 3 | `docs/Cogeto-Model-Split-Roadmap.md` | 34 | Session-planning roadmap that assigns work to specific AI models; superseded for O4 to O7 by the v1 Roadmap Revision and entirely by the V2 plan. Also the single worst piece of AI-process residue in the repo (see §D). | One pointer line in `Cogeto-v1-Roadmap-Revision.md`. |
| 4 | `docs/Cogeto-Roadmap-Revision-Email-Calendar.md` | 66 | Self-declares **SUPERSEDED / folded into** the v1 Roadmap Revision; kept "for provenance". | Drop the `docs/README.md:19` row and one pointer in `Cogeto-v1-Roadmap-Revision.md`. |
| 5 | `docs/Cogeto-v1-Roadmap-Revision.md` | 118 | Still labelled **BINDING** for "the remaining v1 plan", but v1.0.0 shipped 2026-07-17 and the tree is v1.1.0; nothing in it remains unfinished. | 15 inbound references, the largest cleanup in this audit: `CLAUDE.md` doc map, `docs/README.md` precedence paragraph, `docs/Cogeto-v1-scope.md`, `docs/Cogeto-v1-Addendum-Verifiable-Memory.md`, `docs/Cogeto-Technical-Architecture.md`, decisions 0028/0030, `docs/notes/{email-inbound,operator-script}.md`, `project/src/connectors/README.md`, `project/services/mail/README.md`, plus the dated audit. Owner call: the V2 plan should inherit the "BINDING" label explicitly first. |
| 6 | `docs/notes/email-source.md` | 213 | Delivered O4 working note, zero inbound references, but it may be the only prose description of email as a first-class source. | Confirm decisions 0028/0031 plus `docs/security/inbound-email-anti-spoofing.md` cover it; otherwise promote to `docs/features/email.md` instead. |
| 7 | `docs/notes/memory-passport.md` | 125 | Delivered O5-B working note, zero inbound references, but the passport is a published external contract. | Confirm `docs/passport-schema/README.md` carries the operator-facing content; otherwise merge into it. |
| 8 | `docs/notes/instance-context.md` | 105 | Delivered P6.6 working note. | Three decisions (0051, 0052, 0053) point at it for detail; each would need its own text to stand alone first. |
| 9 | `project/src/entrypoints/erase-task-conclusions.ts` (+ the `erase:task-conclusions` script in `package.json:35`) | 170 | One-shot pre-migration eraser that **had to run before migration 0035**, which is already applied on every instance the owner controls. | Deleting it breaks the documented 1.1.0 upgrade path for any instance that has not migrated yet (`docs/operator-runbook.md:465`). Keep until the next major release states 1.1.0 as the minimum upgrade source. |
| 10 | `docs/audits/quality-security-audit.md`, `launch-security-audit.md`, `launch-gap-audit.md`, `launch-platform-audit.md`, `launch-acceptance.md`, `implementation-gap-audit.md` | 1,619 | **Listed separately per instruction: these are deliberately published transparency artifacts, not archaeology.** `SECURITY.md:54` promises every finding and its resolution is published here, and `docs/security/README.md:69-79` indexes all six by name. | **Recommendation: keep all six, delete none.** Deleting any of them breaks a public promise. They are listed here only so the owner sees the set explicitly. If any is retired, `SECURITY.md` and `docs/security/README.md` must change in the same commit. |

`docs/audits/current-state-2.0.md` (544 lines) is **not** archaeology: it is the working input to the
in-flight V2 plan and is cited by decision 0060. It retires when V2.0 item 3.7 completes.

---

## 3. REWRITE-LEAN

| # | Path | Now | Target | What to cut |
|---|---|---|---|---|
| 1 | `README.md` | 181 | ~90 | Reads as a changelog of shipped priorities. "Sovereignty and the model story" is 5 paragraphs stating the same claim; the last four sections each announce a delivered feature with a link to its working note. Keep: the pitch, the four signature mechanisms, quickstart, architecture at a glance, links, license. Move the feature prose to `docs/features/`. Delete the competitor line in the skills paragraph ("competitors cannot enter it without rebuilding their foundations"): marketing, not a front door. |
| 2 | `CLAUDE.md` | 106 | ~70 | **Keep every binding rule and the whole "Needs owner sign-off" list verbatim.** Cut: the "Status and what to do first" section, which says "the next session is the first coding session" and lists migration 0001 as the next task, at v1.1.0 with 36 migrations applied. Fix `7-state status` (line 51): the enum has **six** states (`project/shared/src/memory.ts:7`). Rewrite the doc-map table against the surviving doc set. |
| 3 | `AGENTS.md` | 122 | ~110 | Already lean and almost entirely binding. Two edits only: the header says the Addendum "wins over every other document" while `CLAUDE.md` makes the V2 plan binding for the current cycle (state the precedence once, in one place); and the §A.6 checklist should name the sixth status explicitly rather than by count. Every checkbox stays. |
| 4 | `docs/README.md` | 85 | ~40 | Index rewrite against the new tree. Drop the "History" section (`sessions/`, `handoff/`) and the three-way precedence paragraph, which will be one line once items 2.3 to 2.5 resolve. |
| 5 | `docs/decisions/` | 60 records | see below | Recommendation, not a decision. |
| 6 | `docs/glossary.md` | 167 | ~120 | Mostly earns its place; names in code must match it and that rule is live. Trim the "Product surfaces & features" section, which describes surfaces rather than defining terms. |
| 7 | `docs/eval/history.md` | 1,364 | ~150 | An append-only log of 116 individual runs, duplicated in structured, schema-validated form by `eval/trust-scores/*.json` (11 releases). Keep the current release's runs plus the method note; move the rest behind the trust-score files, which are the published artifact. |
| 8 | `docs/operator-runbook.md` | 551 | ~250 | Operator machinery, stays. Operative content is the numbered procedures; the surrounding rationale, restated rulings, and the trial-tracker section can go. |
| 9 | `docs/Cogeto-Technical-Architecture.md` | 439 | ~200 | The "phased implementation" half is a plan that fully executed; it now documents a past state. Keep stack rationale, containers, mechanisms. |
| 10 | `docs/Cogeto-v1-scope.md` | 218 | ~100 | Positioning and business model still bind; the v1 sequencing and the "locked scope" tables are history. |
| 11 | Surviving `docs/notes/*` | 5 files, 592 | promote | `capabilities.md`, `local-models.md`, `named-skills.md`, `natural-conversation.md`, `web-research-privacy.md` are linked **from the README** and are therefore feature documentation living under a directory named "notes". Move to `docs/features/`, strip the "Delivered 2026-07-xx (issues #x/#y, decision NNNN, migration NN)" headers that open each one, and merge `local-models.md` with `model-providers.md` into `docs/features/models.md`. |
| 12 | `docs/notes/{email-inbound,operator-script,cicd-setup}.md` | 372 | keep, trim | Genuinely operational (`email-inbound.md` is referenced from `docker-compose.yml:658`; `cicd-setup.md` from two workflows). Move to `docs/operations/`, drop the "what was created" framing. |

### `docs/decisions/`: honest assessment

Five records document a subsystem that no longer exists and are **superseded in full** by 0060, yet
none carries a status marker. A reader opening `0018-tasks-ui-reminders-digest.md` today finds a
confident specification for reminders, a feature the repo removed.

| Record | Governs | State |
|---|---|---|
| 0013 | Task-engine rulings | Superseded in full by 0060. Still cited by **live code**: `query-rewrite.ts:66,134`, `deletion-saga.ts:125`. |
| 0018 | Tasks UI, reminders, digest | Superseded in full by 0060. |
| 0037 | Task conclusions become memories | Superseded in full by 0060. |
| 0038 | `create_task` chat intent | Superseded in full by 0060. |
| 0054 | Task-derivation first-person rule | Superseded in full by 0060, but the `authored_by_capture_user` flag it introduced (migration 0030) is **still live** in 9 files. |
| 0022 | Ana sandbox | Ruling 1 revised by 0027; the rest binds. Cited by ~30 live files. |

**Recommendation (owner decides): a pruned set, not a consolidated `decisions.md`.** Reasons, in order
of weight: (1) roughly 900 code comments cite decisions by number, so renumbering or collapsing
them breaks every one of those references at once; (2) `AGENTS.md` and `CLAUDE.md` both make "notable
decisions get a numbered record" a standing rule that a single file cannot satisfy without becoming
the thing this audit is trying to remove; (3) the records are short and each is independently
resolvable from a code comment, which is the property that makes them useful.

Concretely: add a `**Status:** superseded in full by 0060` line to the five records above, keep them
in place (they explain why removed code once existed and are cited by dated audits), and add a
`docs/decisions/README.md` with one line and a status column per record. Delete none. The cost of a
wrong deletion here is a code comment pointing at nothing; the cost of keeping them is 60 short files
behind an index.

---

## 4. CODE-COMMENT SWEEP

**1,702 provenance tags** across `project/src` and `project/web`, by kind:

| Tag kind | Count | Verdict |
|---|---|---|
| `§A.x` / `§B.x` (Addendum sections) + `decision NNNN` | 912 | **Reference, not archaeology.** Both targets are living documents a reader can open. Keep where the rule is genuinely non-obvious; drop where the sentence stands without it. |
| `QS-n` fix IDs | 307 | **Delete unconditionally.** Names a fix batch from a 2026-07 audit that no reader can resolve. |
| Session codes (`S3-B`, `F2-A`, `O1-C`, `FIX-1`, `QS-B`) | 166 | **Delete unconditionally.** Names a work session. Pure archaeology. |
| `Priority N`, `P6.x`, `V2.0 item x`, `Post-v1` | 175 | **Delete unconditionally.** Names a roadmap slot in a roadmap that no longer exists. |
| `PR #n` / `issue #n` | 39 | **Delete unconditionally.** Git history holds this. |
| Restatement comments ("// Add an address entry") | 10 | Delete. Genuinely rare; the codebase does not have a restatement problem. |

The comments themselves are, with few exceptions, **good**: they explain invariants, orderings, and
security rationale. The problem is a citation habit, not comment bloat. The sweep should strip the
token and keep the sentence.

### By file, top 10

| File | Tags | Representative examples (3 each) |
|---|---|---|
| `project/src/memory/memory.store.ts` | 60 | `:513` "not persisted (QS-1, decision 0025): it can be model free-text naming private..." **STAYS** (security rationale), drop `QS-1`. · `:124` `// ── Open loops (V2.0 item 3.1, decision 0060) ───` **GOES** (section banner citing a roadmap slot). · `:439` "The supersession chain through a memory, oldest → newest (§B.2, S3-B ...)" drop `S3-B`, keep `§B.2`. |
| `project/src/retrieval/chat/chat.service.ts` | 48 | `:422` "Skill-brief intent (Priority 7, decision 0059): checked BEFORE the ..." **STAYS** (ordering invariant), drop `Priority 7`. · `:92` "The chat area (S3-A). Asking a question is strictly fast path (§A.3)" drop `S3-A`, keep `§A.3`. · `:543` "The research offer (decision 0046): every knowledge-class answer OFFERS" **STAYS** as-is. |
| `project/web/src/api.ts` | 37 | `:75` "bound, decision 0026). Signal the shell exactly once, from the single place" **STAYS** (non-obvious single-signal rule). · `:292` "Per-user capture/upload defaults (§A.9, O1-C Settings)." drop `O1-C`. · `:222` "The plain dreaming digest (§B.6 v1 form, F2-B)" drop `F2-B` and `v1 form`. |
| `project/src/memory/deletion-saga.ts` | 36 | `:41` "every memory row carries NOT NULL provenance (§A.6) and every write path preserves..." **STAYS** (the provability argument). · `:125` "(decision 0013 ruling 6)" **GOES**: 0013 is superseded in full and this comment now cites nothing. · `:68` "acyclic (§A.1 rule 2)" **STAYS** (boundary rule the linter enforces). |
| `project/src/memory/integrity-sweep.ts` | 34 | `:46` "provenance no longer resolves (QS-5/QS-37, decision 0025)" drop both `QS-`. · `:72` "Bucket objects examined by the orphan-object arm (QS-28)." **GOES** entirely (the field name says it). · `:55` "PII bytes outside any receipt's reach" **STAYS** (why the arm exists). |
| `project/src/entrypoints/eval-chat.ts` | 32 | `:47` "the chat-answer eval suite (S3.5-A §2). It seeds a FRESH..." drop `S3.5-A §2`. · `:153` "Per-case user context (P6.6, decision 0052)" drop `P6.6`. · `:179` "The answer must frame past belief as past (decision 0012 ruling 6)." **STAYS** (a testable contract). |
| `project/src/entrypoints/config.ts` | 31 | `:30` "Qdrant API key (QS-4) — required for auth on a reachable deployment" **STAYS**, drop `QS-4`. · `:57` "Inbound email (Session O4, decision 0028)" drop `Session O4`. · `:238` `'... — decision 0022 ruling 4'` inside a **user-facing error string**: move the citation out of the message. |
| `project/src/retrieval/query-rewrite.ts` | 29 | `:66` "Open-loops intent (decision 0013 ruling 7)" **GOES**: cites a fully superseded record. · `:134` same, for the lexicon. · `:9` "(decision 0007 ruling 4; F3)" drop `F3`. |
| `project/src/ingestion/pipeline/pipeline.service.ts` | 24 | 12 `QS-n` tags, all droppable. · `:62` "All six stages are real since F2-A (decision 0010)." **GOES**: "since F2-A" is archaeology and the rest is a state that has been true for a year. |
| `project/src/entrypoints/app-root.module.ts` | 24 | 8 `QS-n` tags. · `:161` "Map a spent daily model budget to HTTP 429 for non-stream endpoints" **STAYS** (restates code, but the *non-stream* qualifier is the point). |

### Comments that explicitly STAY (genuine why)

`deletion-saga.ts:41-48` (the provability argument for enumeration), `memory.store.ts:552,675`
(Qdrant `setPayload` runs last so a throw leaves no divergence), `memory.store.ts:513` (why model
free text is never persisted), `demo/credentials.ts:68` and `demo/bootstrap.ts:57` (`0644` on
purpose, with the reason), `MemoryDrawer.tsx:102` (`404 = user-authored, not an error`),
`integrity-sweep.ts:55` (PII outside any receipt's reach), every `AGENTS.md`-derived boundary note
in the `*.module.ts` files. These are the model the sweep should preserve.

---

## A. Em dash and en dash census

**7,009 occurrences across markdown.** Zero in user-facing strings, in both the frontend and the backend.

| File / group | Count | Disposition |
|---|---|---|
| `docs/eval/history.md` | 3,062 | Machine-appended run log. Exempt, or regenerate without dashes when item 3.7 trims it. |
| `docs/audits/*.md` (7 files) | 665 | Published, dated artifacts. **Leave.** Rewriting a published audit's prose is worse than the dashes. |
| `docs/sessions/*.md` (28) | 483 | Moot: bucket 2. |
| `project/prompts/**` (13 files) | 336 | **Working machinery, exempt.** Model-facing, immutable once released. |
| `docs/operator-runbook.md` | 68 | Fix during the rewrite (item 3.8). |
| `docs/glossary.md` | 58 | Fix during the rewrite (item 3.6). |
| `docs/Cogeto-v1-scope.md` | 50 | Fix during the rewrite. |
| `project/eval/golden/CHANGELOG.md` | 48 | **Golden-set data, exempt.** |
| `CLAUDE.md` | 31 | Internal contract, not product copy. Optional. |
| `docs/decisions/*.md` (60) | ~700 | Optional; low value per edit. |
| Everything else | ~1,500 | Fix opportunistically. |

**User-facing strings: clean.** The ESLint rule `copy/no-typographic-dashes`
(`eslint.config.mjs:14-42,81-85`) covers `Literal`, `JSXText`, and `TemplateElement` under
`project/web/src`, and it holds: all 100 dash occurrences under `project/web/src` are in code
comments or `.spec` files, both exempt by design. A separate sweep of every non-spec string literal
in `project/src` (backend errors, log lines, digest text) found **zero** dashes, so the backend gap
in the guard's coverage is currently theoretical.

**Proposal, two parts:**
1. **Extend the guard to the backend** by adding `project/src/**/*.ts` (ignoring `*.spec.ts`) to the
   rule's `files` glob. It costs nothing today and prevents the gap from opening.
2. **Add a markdown check**, not an ESLint rule: a `lint:docs` npm script grepping `[—–]` over a
   curated glob, wired into the existing `lint` CI check. Exempt list, stated in the script so it is
   auditable: `docs/eval/history.md`, `docs/audits/**`, `docs/decisions/**`, `project/prompts/**`,
   `project/eval/**`. Enforce over `README.md`, `docs/*.md`, `docs/features/**`, `docs/security/**`,
   `docs/operations/**`, and the repo-root policy files, which is exactly the set an outsider reads.

---

## B. Contradictions between docs and current code

| # | Claim | Where | Reality |
|---|---|---|---|
| 1 | "the next session is the first coding session"; next task is migration 0001 | `CLAUDE.md:44-52` | v1.1.0 shipped; 36 migrations applied. The whole "Status and what to do first" section is false. |
| 2 | `status` enum has **7 states** | `CLAUDE.md:51`, `docs/Cogeto-v1-Addendum-Verifiable-Memory.md:189` | Six: `project/shared/src/memory.ts:7`. `AGENTS.md:14` and decision 0003 say six correctly. |
| 3 | `docs/Cogeto-v1-Roadmap-Revision.md` is **BINDING** for "the remaining v1 plan" | `CLAUDE.md` doc map, `docs/README.md:5-8` | Nothing in it remains; v1 shipped 2026-07-17. The V2 plan is the live plan but is labelled "FOR CONFIRMATION". |
| 4 | `handoff/` described as holding "the retired task engine, kept as history" and `sessions/` as current index entries | `docs/README.md:79-81` | Correct as written but advertises archaeology as documentation in the front-door index. |
| 5 | Migration comment points at `scripts/dev/erase-task-conclusions.mjs` | `project/src/migrations/0035_remove_tasks.sql:14` | **No such file.** The eraser is `project/src/entrypoints/erase-task-conclusions.ts`, run via `npm run erase:task-conclusions`. A stale path in an applied migration's instructions. |
| 6 | Passport manifest v1.0 lists `tasks` in `required`, with `tasks.schema.json` and a `sample/tasks.json` | `docs/passport-schema/1.0/` | Tasks no longer exist. v2.0 correctly drops them. **Keep 1.0 anyway:** it is a published contract for archives already exported, and deleting it would break independent verification of those. Flagged, not proposed for removal. |
| 7 | Decisions 0013/0018/0037/0038/0054 read as current specifications | `docs/decisions/` | All five superseded in full by 0060; none carries a status marker. See §3. |
| 8 | Live code cites decision 0013 as governing | `query-rewrite.ts:66,134`, `deletion-saga.ts:125` | 0013 is superseded in full. The **code** is correct (open-loop intent is a live feature); only the citation is dead. |
| 9 | Nine live files cite decision 0054 for the `authored_by_capture_user` flag | `email.source-reader.ts:36`, `memory.store.ts:49,1301`, `source-reader.ts:29`, and 5 more | 0054 is superseded in full, but the flag it introduced is still load-bearing. The rule needs re-homing into 0060 or a new record before these citations mean anything. |
| 10 | `docs/notes/` described as "developer-facing notes per feature area" | `docs/README.md:61` | Five of them are the README's own feature documentation for outsiders. |

---

## C. Target `docs/` information architecture

Roughly 40 files, readable end to end in well under an hour.

```
docs/
  README.md                         index, ~40 lines
  architecture.md                   from Cogeto-Technical-Architecture.md, trimmed
  glossary.md
  engineering-workflow.md           unchanged (working machinery)
  eval-golden-set.md                unchanged (working machinery)
  running-locally.md
  deployment.md
  release-process.md
  operator-runbook.md               trimmed
  Cogeto-V2-Plan.md                 the live plan
  Cogeto-v1-Addendum-Verifiable-Memory.md   binding architecture, cited by AGENTS.md
  Cogeto-v1-scope.md                trimmed to positioning and business model
  Cogeto-v1-Specification.docx      owner-maintained binary
  Cogeto-Technical-Architecture.docx  presentation copy

  features/          conversation.md · web-research.md · named-skills.md ·
                     models.md · capabilities.md · email.md
  operations/        adding-users.md · image-pins.md · email-inbound.md ·
                     operator-script.md · cicd-setup.md
  security/          README.md + 7 topic files (unchanged)
  research/          README.md + 5 pattern files (unchanged; required reading per AGENTS.md)
  design/            README.md
  decisions/         README.md index + 60 records with status markers
  audits/            6 published audits + current-state-2.0.md (retires with V2.0 item 3.7)
                     + this report
  passport-schema/   1.0/ and 2.0/ (published contracts, unchanged)
  trust-scores-schema/
  dockerhub/         3 files (consumed by dockerhub-overview.yml)
  eval/history.md    trimmed to the current release
  assets/            2 diagrams
```

Gone: `sessions/`, `handoff/`, `notes/`, `Cogeto-Post-v1-Backlog.md`,
`Cogeto-Model-Split-Roadmap.md`, `Cogeto-Roadmap-Revision-Email-Calendar.md`,
`Cogeto-v1-Roadmap-Revision.md`.

---

## D. AI-process residue

Excluding the legitimate working machinery (`CLAUDE.md`, `AGENTS.md`, `project/prompts/`,
`project/eval/`, `.claude/`), which is correctly present in an agent-developed repository.

| # | Where | What | Severity |
|---|---|---|---|
| 1 | `docs/Cogeto-Model-Split-Roadmap.md` | Title and body assign engineering work to named commercial AI models ("Fable 5 now, Opus 4.8 later"; "Fable 5 does everything where subtle correctness lives; Opus 4.8 executes precisely specified work"), and define the delivery process around "Fable handoff specs" that "Opus sessions implement". A professional repo does not publish its model-assignment strategy as a roadmap. | **High.** Bucket 2 item 3. |
| 2 | `docs/sessions/` (28 files) | Per-session logs whose organising unit is one AI working session (`S3.5-A`, `O1-C`, `FIX-2`). Several narrate the prompt: `O1-A.md`, `S3.5-A.md`, `F3-B.md`, `doc-sync-roadmap-revision.md`. | **High.** Bucket 2 item 1. |
| 3 | `docs/decisions/0007-quality-hardening-rulings.md:12` | "`docs/sessions/S3-A.md`, which **the prompt** calls 'decision 0004'": a binding record adjudicating between a prompt's wording and a session log. | **Medium.** Rewrite the ruling without the meta-commentary. |
| 4 | `docs/decisions/0016-discard-settings-audit.md:10-14` | Ruling titled "Discard mode follows the FROZEN handoff, **not the prompt's paraphrase**", with a standing rule that "frozen handoff beats a prompt". | **Medium.** The ruling is real; the framing is process residue. State what the rule is. |
| 5 | 166 session codes in code comments | `S3-B`, `F2-A`, `O1-C`, `QS-B`, `FIX-1` scattered through `project/src` and `project/web`. | **Medium.** Bucket 4. |
| 6 | 175 roadmap-slot tags in code comments | `Priority 7`, `P6.5`, `V2.0 item 3.1`, `Post-v1 Priority 4`. | **Low.** Bucket 4. |
| 7 | Every `docs/notes/*.md` opening line | "Working notes for decision 0041 (issues #181/#182/#183)", "Delivered 2026-07-24 (issues #248/#249/#250, decision 0056, migration 0031)". Five of these are linked from the README as feature documentation. | **Medium.** Item 3.11 strips the headers. |

Checked and clean: no `Co-Authored-By` trailers, no "Generated with" lines, and no Anthropic or
Claude references anywhere in git artifacts or committed source. The three `.ts` files matching a
model-name grep (`provider-config.ts`, `trust-scores.spec.ts`, `model-config.spec.ts`) reference
Anthropic as a **supported provider adapter**, which is product functionality.

---

## Summary

| Bucket | Files | Code symbols | Lines removed (approx.) |
|---|---|---|---|
| 1. DELETE | 12 | 7 unused exports in 5 files | 1,565 md + ~60 code |
| 2. MOVE-TO-TRASH | 37 (of which 6 recommended **keep**: the published audits) | 1 entrypoint + 1 npm script | 4,092 md, 1,619 of it recommended to stay |
| 3. REWRITE-LEAN | 12 entries covering ~18 files | n/a | ~2,700 md trimmed, 0 removed outright |
| 4. CODE-COMMENT SWEEP | 1,702 tags across ~120 files | n/a | 687 tags delete unconditionally; 912 keep-or-trim case by case |

Net: `docs/` goes from 100 markdown files to roughly 40, and from 26,192 lines to roughly 12,000,
without deleting a single published contract, decision record, prompt artifact, golden-set case, or
CI configuration.

### The three riskiest proposed deletions

1. **`docs/handoff/` (bucket 2, item 2).** Seven decision records cite handoff sections *as binding
   authority*, and decision 0016 sets a standing precedence rule ("frozen handoff beats a prompt")
   that only resolves if the handoff exists. Deleting these files silently demotes seven rulings from
   "specified" to "asserted". Inline every quoted constraint first, and verify each inlining against
   the code it governs.

2. **`docs/Cogeto-v1-Roadmap-Revision.md` (bucket 2, item 5).** Fifteen inbound references including
   `CLAUDE.md`'s doc map, and it is the only document currently carrying the word BINDING for
   connector scope and the dropped-calendar decision. The V2 plan is still labelled
   "FOR CONFIRMATION", so removing this leaves a window with **no** binding plan document. Promote
   the V2 plan first; delete this second.

3. **`docs/notes/memory-passport.md` and `email-source.md` (bucket 2, items 6 and 7).** Both have
   zero inbound references, which is exactly why they are easy to delete and risky to delete: zero
   references can mean "superseded" or "the only copy nobody linked". The passport is an externally
   published format with independent verifiers; email-as-a-source is the newest connector. Confirm
   the replacement doc actually carries the content before either moves out of `trash/`.
