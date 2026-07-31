# Cogeto 2.0: Complete Plan

**Status: BINDING.** This is the plan of record for the 2.0 cycle and supersedes every earlier roadmap. Every confirmed item from the 2.0 discussion is here, assigned to a version, with priority and difficulty. Section 10 is a traceability checklist: if something you asked for is not there, it was missed and must be added. Nothing in this plan is optional-by-omission.

Difficulty: **S** = days · **M** = one to two weeks · **L** = multi-week · **XL** = a month or more.
Priority: **P0** = blocks the version · **P1** = core of the version · **P2** = valuable, can slip one version.

---

## 1. The business driver (decided)

**The wedge: auditable findings over document sets.**

Point Cogeto at a folder of documents; it reads all of them (including scans and spreadsheets), anchors every fact to its subject and its exact span, detects contradictions and supersessions across the whole set, and produces a **signed, printable findings report** an auditor or QA lead can forward. Value arrives in an afternoon, not in weeks.

Why this and not something else: the report is a *forwardable artifact* (chat answers are not), bulk import removes the empty-box problem that kills trials, and contradiction detection with provenance over a document corpus is a job nobody else does honestly. It also uses every asset already built: verification-before-storage, temporal validity, receipts and signing, the eval harness, provenance.

The original professional-memory product remains the base and is not abandoned; the findings wedge is what makes a stranger pay. Everything in 2.0 up to and including V2.3 builds toward one demo sentence: *point it at 400 documents and get a signed findings report.*

---

## 2. Principles introduced in 2.0

1. **Cogeto resolves its own reviews.** Unsupported, partial, and hedged extractions are handled automatically (stored as uncertain, demoted in retrieval, never blocking). There is no manual approval queue for facts. Every automatic suppression or demotion is logged so it stays inspectable and reportable.
2. **Contradictions are surfaced, not queued.** They appear in context (on the source, in the answer, in the report), never as a chore list.
3. **Chat is the door; Sources is the proof.** Things enter through conversation; Sources is where you see and prove what the system knows.
4. **No feature ships without its eval cases and gates.** Published metrics include the unflattering ones.
5. **Boundaries are contracts, not conventions.** Imports, table ownership, job types, and DI tokens all count as boundaries.

---

## 3. V2.0: Clean core and truthful metrics

*Goal: remove what is not working, make the published numbers honest, stop the manual review burden, and prepare the ground so later versions do not land in god files.*

| # | Item | Priority | Difficulty |
|---|---|---|---|
| 3.1 | **Full task removal, backtraced**: **DELIVERED** 2026-07-28 (migration 0035) | P0 | M |
| 3.2 | **Reminders dropped**: **DELIVERED** 2026-07-28 | P0 | S |
| 3.3 | **Automatic review resolution + suppressed-fact log**: **DELIVERED** 2026-07-31 (migration 0039) | P0 | M |
| 3.4 | **Trust-score honesty and eval gates (first wave)** | P0 | M |
| 3.5 | **i18n foundation (en/hr/de, user-level)** | P1 | M |
| 3.6 | **Targeted modularization** | P1 | L |
| 3.7 | **Correctness and hygiene debts from the audit** | P1 | S to M |

**3.1 Full task removal.** **DELIVERED 2026-07-28** (migration 0035): open loops are memory-backed, the receipt field stays permanently optional, the passport is at version 2.0. Delete the tasks module (21 files, 3,886 lines), both tables, both enums, 8 endpoints, both prompt families, 5 worker jobs, the reminders CLI, the Tasks page and every tendril (nav badge, dashboard stats, attention kinds, drawer "make this a task", skills accept-as-task, conversation delete preview, API client, query keys), 12 task-pair + 6 derivation-trap + 7 chat eval cases, and the task sections inside the answer and query-rewrite prompts. Five risk points handled deliberately: (a) `tasks_removed` stays as an optional field in the signed receipt `counts_json` forever, so historical receipts still verify; (b) memories carrying `source_type='task_conclusion'` provenance are deleted through the saga before the table goes, since the enum value cannot be dropped and the integrity sweep would flag orphans; (c) the passport manifest's required `tasks` key is a breaking schema version bump under the existing versioning rule; (d) attention, dashboard DTOs, retrieval's static task imports and the chat intent routing order are edited together; (e) demo assertions and the two migrations that enqueue task jobs are cleaned. **Preserved, re-fed from memory:** `commitment`/`open_loop` kinds, the dormant-flag table, the open-loops question path (reads memory rows directly), due-dates from `memory.valid_until`, and the attention surface. No deployed instance exists, so the cut is total: no compatibility shims.

**3.2 Reminders dropped.** **DELIVERED 2026-07-28**. Not rebuilt in 2.0. Due-dates remain visible through attention and Sources. A notification layer may return later as its own feature if partners ask.

**3.3 Automatic review resolution.** **DELIVERED 2026-07-31** (migration 0039). The Review station as a manual queue is gone: the page keeps its route but shows contradictions only, and its nav label, badge, attention line and dashboard tile went with the queue. Unsupported, partial, hedged and unjudgeable outcomes are admitted as `uncertain`, demoted by the existing status multipliers, framed softly in answers, and never blocking, with no human action anywhere in the path.

The single undifferentiated bucket is split into six frozen sub-reasons on `memory.uncertainty_reason`, mapped **totally** from what the verification stage can actually distinguish today, with no default arm: `hedged_in_source`, `partially_supported`, `unsupported`, `unjudgeable`, `structurally_invalid` (the one non-admission case: a blank claim or a blank span) and `legacy_unspecified` (backfill only). A low-confidence-extraction reason was deliberately **not** added, because the extractor emits no confidence signal to justify one. Admission itself is byte-identical to the rule that preceded the taxonomy, so no eval metric moves: labelling split the bucket, it did not move the line.

Every automatic demotion or non-admission writes a `suppressed_fact_log` entry (fact as extracted, source, exact span, sub-reason, verification detail, timestamp, memory id or NULL when withheld), gated exactly as memories are and queryable by source, reason and date range with counts. It is content-bearing, so it joins the deletion saga over every enumerated source and the receipt counts it under `suppressed_facts_removed`; retention is the life of the source. Confirming a fact survives as a contextual action on the memory drawer, producing `user_approved` with its existing precedence. Contradictions were excluded from this path throughout: they are surfaced per principle 2, and their resolution flow is untouched.

**3.4 Trust-score honesty and eval gates, first wave.** Publish contradiction **precision** (measured 0.857, currently hidden) and the **supersedes** result (currently 0/1 failing) on the trust page; gate both. Introduce **per-language floors** so Croatian cannot hide inside an aggregate (dedup hr 0.833 is under the 0.90 gate today, masked). Raise extraction and verification floors toward the specification's own thresholds or justify each floor explicitly. Document the v1.1.0 precision drop of 3.8 points, which breached the project's own "more than 2 points must be justified" rule. Add **query-rewrite eval cases** (load-bearing, only indirectly covered today). Run **evals on pull requests via cached model responses**, so regressions surface before merge instead of after.

**3.5 i18n foundation.** User-level language for **English, Croatian, German**, English as the default and fallback. Frontend: a mainstream library (react-i18next or equivalent), all UI strings extracted to key files, a **key-sync check in CI** so a missing or orphaned key fails the build. Translation files for hr and de are created with keys in place; authored translations are not part of this work. Backend: the ~10 files with inline en/hr strings move behind the same key discipline, and system-generated content continues to follow the existing per-user preferred-language rule. Date and number formatting follows the locale (fixing the hardcoded `en-GB` site the audit found). **Stated honestly and prominently:** UI language support is not extraction-quality support. German memory quality is unproven until a German golden corpus exists with its own gates; until then German is a UI language only, and the trust page says so.

**3.6 Targeted modularization.** Not a full rewrite: the split the rest of 2.0 depends on. Define the **boundary contract** (imports, table ownership, job-type contracts, DI tokens) and close the enforcement gaps the audit found: barrel laundering of live Drizzle tables, the missing `passport` entry in the dependency rules, the global-module policy (7 of 11 today), and raw SQL reaching across modules from the composition root. Split the two god surfaces: **`connectors/`** (7.9k lines, six unrelated families) into its families, moving chat-the-connector out of retrieval where it structurally belongs; and **`chat.service.ts`** (1,154 lines with positional-order-load-bearing optional DI) into an orchestrator with explicit intent handlers, because chat becomes the capture surface in V2.2 and will only grow. Convert `source_type` from a hard Postgres enum into a **registry**, since every new reader and connector otherwise costs a memory-owned migration plus a hardcoded-switch tax across six files. Dissolve the accidental thirteenth context in `entrypoints/`.

**3.7 Correctness and hygiene debts.** Audit-log **read events** including passport export (a full-corpus export currently writes no audit row, in a product whose category is verifiable memory), file downloads, and model-gateway egress. Gate the instance-wide **receipts-verify** endpoint, which today exposes every user's source ids and counts to any authenticated caller. Close the `MemoryStore` ungated system methods behind a worker-only construction rather than convention. Stamp scope on chat capture (silently defaults today). Evict dev-seed and demo code from the production image. Rewrite the badly stale CLAUDE.md. Consolidate the duplication the audit itemized where it is cheap: 27 identical Zod adapters, the byte-identical citation resolvers, the triplicated shared-scope SQL, the three eval-harness skeletons.

---

## 4. V2.1: Read everything, anchored

*Goal: no document arrives that Cogeto cannot read, and every fact knows what it is about.*

| # | Item | Priority | Difficulty |
|---|---|---|---|
| 4.1 | **Reading layer: spreadsheets, scans, vision** | P0 | L |
| 4.2 | **Source-context anchoring** | P0 | M |
| 4.3 | **Per-source extraction gate** | P0 | M |

**4.1 Reading layer.** Extend beyond PDF and DOCX text to **XLSX and CSV** (sheets and tables flattened into extractable statements) and to **scanned or image-only PDFs**, which today pass silently as "done, zero facts". Scanned pages go first through **local OCR** (Tesseract-class, CPU-only, English and Croatian language packs, in-instance, nothing leaves the box). When the instance runs a **local vision model** via the local runtime, hard cases (poor scans, handwriting, tables, simple diagrams) are read by the vision tier through the model gateway. Recovered text enters the existing pipeline unchanged: extraction, independent verification against the recovered span, statuses, provenance to the file and page. A file that still yields nothing readable is **honestly labelled** ("scanned document, no readable text") in the source drawer rather than shown as processed: no silent emptiness, no fabricated facts. Ships with golden cases per format and language; the vision path is eval-gated like every other model task.

**4.2 Source-context anchoring.** At the read stage, before chunking, one cheap model call over the document's opening (first pages, title block, headers) plus its filename produces a **source context**: subject entities (product models, project names, parties), document class (datasheet, spec, manual, contract), and revision, each marked confident or uncertain. Stored on the source row and injected into every chunk's extraction call, so a chunk saying only "Device has one antenna" extracts as a fact about model AAA rather than about "device". Where a document covers several models, section headings carry the per-section subject and the extractor prefers the nearest explicit subject over the document default. Multi-value and low-confidence cases **fall back to current behavior** (generic entity) rather than guessing, so anchoring can only reduce ambiguity, never invent it. The context is visible on the source detail and **editable**; correcting it re-anchors that source's facts as supersessions. Golden cases gate it: two same-boilerplate datasheets for different models must neither merge nor flag as contradiction, and one multi-model datasheet must anchor per section.

**4.3 Per-source extraction gate.** The analogue of the first-person rule, for extraction rather than tasks, and the prerequisite for bulk import and observed connectors. Per-source and per-connector controls: enable/disable extraction, fact budgets, retention, and admission rules, generalizing the email allowlist precedent (which channels, which folders, which document classes). Without it, one bad folder floods the corpus at full model cost. Includes prompt-injection defence for observed content, which the extraction prompt lacks today.

---

## 5. V2.2 Sources: capture, proof, and volume

*Goal: chat is the only door; Sources is the audit surface; a trial starts full instead of empty.*

| # | Item | Priority | Difficulty |
|---|---|---|---|
| 5.1 | **Chat-centric capture** | P0 | M |
| 5.2 | **Sources: three-level redesign** | P0 | L |
| 5.3 | **Bulk import** | P1 | L |

**5.1 Chat-centric capture.** Remove the standalone "Remember this" note field and the file upload from the Memories tab. Notes are captured only through the existing "Remember this" in chat. Files attach in chat via **paperclip**; an attached file is ingested through the normal pipeline by default, with chat confirming inline: *"added to sources: 47 facts, 1 contradiction"*. A **"don't remember this file"** toggle keeps a file transient and conversation-only. Single upload and bulk import both live on the Sources page for deliberate ingestion.

**5.2 Sources, three levels.** The Memories tab becomes **Sources**, read, audit, and resolve only:
- **Sources list (default view):** one row per document, note, or email, with name, date, fact count, and status badges (contradictions, superseded, suppressed).
- **Source detail:** every extracted fact with its status and **exact source span**, plus the anchoring context (editable, per 4.2) and the suppressed-fact log for that source.
- **Fact detail:** full lifecycle: extraction, verification result and its span, supersession chain, and which answers cited it.
The old flat all-memories list is demoted to a **filtered search view** across facts (contradicted, changed since a date, content search).

**5.3 Bulk import.** Point Cogeto at a folder, ZIP, or S3 path of hundreds of documents: **manifest first** (list, sizes, types, dedup by content hash), then queued ingestion through the existing pipeline with **per-tenant concurrency caps** so one import cannot starve the instance, progress visible on Sources, and one summary when done: *"412 documents, 9,847 facts, 37 contradictions, 214 superseded."* Requires 4.3. That closing summary is the sales demo.

---

## 6. V2.3 Findings: contradictions that hold, and the artifact

*Goal: the thing a QA lead forwards. This version is the wedge.*

| # | Item | Priority | Difficulty |
|---|---|---|---|
| 6.1 | **Contradiction coverage overhaul** | P0 | L |
| 6.2 | **Report generator** | P0 | M |
| 6.3 | **Ambiguity detection and fan-out answers** | P1 | M |
| 6.4 | **Eval gates, second wave (vertical corpus)** | P1 | M |

**6.1 Contradiction coverage overhaul.** Today two directly contradicting documents can be missed temporarily (near-simultaneous uploads never pair inline; the per-fact budget of three checks skips the true conflict on crowded topics; uncertain facts are excluded until confirmed) and, worse, **permanently**, because both the inline and nightly passes use the same gates. Fix each named gap:
- **Entity matching beyond byte-equality:** aliases, typos, and cross-language subjects (today "Adriatic Foods" and "Jadranske hrane" can never pair). Anchoring from 4.2 feeds this directly.
- **The 0.80 to 0.93 similarity band and the escalation hole:** a `related` dedup verdict never escalates, so high-similarity paraphrased conflicts are structurally invisible.
- **Numeric and unit reasoning:** none exists today; a judge prompted "in doubt, compatible" will not catch 3.2 mm versus 3.4 mm.
- **Persist `compatible` verdicts in a checked-pair ledger,** so borderline pairs are not re-judged nightly and cannot flip to contradicted days later from model variance alone. This also removes a recurring nightly token cost.
- **Supersession interval arithmetic:** fix the failing case where both sides carry explicit validity and the judgment still misses.
- **Per-embedding-model threshold calibration:** the 0.80 and 0.93 constants silently mean something different under a different embedding model.
- **Budget and pairing policy** so crowded topics and simultaneous ingestion cannot hide the true conflict; contradictions found later are surfaced with their detection date, since the report must state when a finding appeared.

**6.2 Report generator.** A signed, printable artifact from a findings run. Header: instance, corpus, date range, model configuration, and the trust scores for that configuration. Then **per contradiction**: both claims, both verbatim source spans, document plus revision plus location, detection date, resolution status. Then **superseded facts with their chains**. Then the **suppressed-fact log summary** from 3.3. Formats: **PDF** for the auditor, **JSON** for machines. Reuses the passport assembler pattern and receipt signing, so the report is verifiable the same way receipts are.

**6.3 Ambiguity detection and fan-out answers.** After fusion, the answer path computes the score distribution across anchored-entity clusters and acts deterministically, with no user configuration and one behavior always: a **single dominant cluster** answers normally with citations; **no cluster above the relevance floor** means the corpus is silent, and the answer says so explicitly, then continues with general model knowledge under a clear "not from your sources" banner; **several comparable clusters** with distinct subject entities produce a **fan-out answer**, one line per cluster with fact, citation, and validation verdict where the question implies one, ending with "which did you mean?". Never a silent guess, never a bare clarifying question. Detection is deterministic (post-RRF score distribution over entity groups, thresholds versioned like the reconcile config), costs no extra model call, and depends on 4.2 for clean clusters. Gated by three golden cases: a context-resolved fragment that must pick the thread's subject; a cold ambiguous value that must fan across exactly the domains holding related facts; and a silent-corpus question that must banner general knowledge without fabricating a source.

**6.4 Eval gates, second wave.** A **vertical golden set**: 30 to 50 labeled cases from real regulatory or requirements documents, because the engine is proven on notes and emails while the claim being sold is about the buyer's document type. **Numeric/unit and cross-language contradiction pairs** (zero exist today). **Authority-ranking cases** once that ships. Anchoring and fan-out cases from 4.2 and 6.3 land here as gates.

---

## 7. V2.4 Operate: configuration, cost, and observability

| # | Item | Priority | Difficulty |
|---|---|---|---|
| 7.1 | **Provider configuration in the database + admin UI** | P0 | M |
| 7.2 | **Token accounting and the counterfactual** | P1 | M |
| 7.3 | **Cost reduction programme** | P1 | M |
| 7.4 | **Observability** | P1 | L |
| 7.5 | **Airgap hardening** | P2 | S to M |

**7.1 Provider configuration in the database.** Move model and provider configuration out of `.env` into the database with **encrypted keys**; the master key stays in `.env`; existing `.env` values seed the database on first run. An **admin UI page** manages providers. The **chat model becomes user-switchable** in the UI. Extraction and verification models stay **admin-only**, each shown with **its eval trust scores**, and untested combinations flagged as **"not evaluated."** `.env` keeps only bootstrap: database credentials, master key, instance configuration. This is also the natural break point for the legacy environment-variable expansion kept for v1 parity.

**7.2 Token accounting and the counterfactual.** Per-operation token accounting (the budget infrastructure exists; this surfaces it) rolled up per user, per instance, and per period, visible in an admin view, broken down by task family (extraction, verification, reconciliation, answering, research, vision). Plus the **counterfactual comparison**: what the same work would have cost without Cogeto, defined as a documented, checkable baseline (for example, feeding the full text of every source that a set of answers cited, or the full corpus for corpus-wide questions) rather than an invented multiplier. Shown as an estimate with the methodology stated and linkable, per the project's own honesty rules. Done right, this is both a cost tool and a sales artifact; done loosely it is exactly the kind of claim this brand cannot afford.

**7.3 Cost reduction programme.** Concrete levers, most of which fall out of work already planned: the checked-pair ledger stops re-judging compatible pairs nightly (6.1); anchoring reduces ambiguous re-extraction (4.2); the per-source extraction gate stops corpus flooding (4.3); content-hash dedup avoids re-ingesting identical documents (5.3); batch verification and pipeline-tier routing already exist and are audited for gaps; cached evals cut CI spend (3.4); local models remove the highest-volume external call. Each lever is measured against the accounting from 7.2 rather than assumed.

**7.4 Observability.** Today there is health, structured logs, and a jobs view, and **no metrics, no tracing, no alerting**. Add metrics (counters and latency series per stage, per provider, per job type), **correlation IDs** so one request can be followed from HTTP through job to model call, an alerting hook for degraded health and integrity alerts, log shipping and retention guidance, and historical health. Complete the **read-audit coverage** started in 3.7 and give the audit log a retention policy and an export path.

**7.5 Airgap hardening.** Offline is already genuinely working (local model preset, local embeddings, in-instance storage, no telemetry, one CI-enforced egress seam, and a recorded offline eval of 24 of 27 chat cases). Close the remaining gaps: an **offline image bundle** story (`docker save`-style) since image pulls are the only remaining network need, and move the three services still built from source rather than pulled as images.

---

## 8. V2.5: Connect and organize

| # | Item | Priority | Difficulty |
|---|---|---|---|
| 8.1 | **Connector platform** | P0 | L |
| 8.2 | **First external connector (by demand)** | P1 | M each |
| 8.3 | **Projects as workspaces** | P1 | M |

**8.1 Connector platform.** All greenfield, per the audit: **credential storage** (token table, secret encryption, refresh loop, kept inside the identity seam), **sync and cursor state** (delta and history tokens: promised in the README, never implemented), **outbound rate limiting** (no token bucket or Retry-After handling exists), a **webhook ingress framework** (HMAC, replay protection, dedup, subscription renewal), and **natural-key deduplication** so a polling connector re-returning the same item does not cost N extractions (no remote-id uniqueness exists anywhere today). The `source_type` registry from 3.6 and the extraction gate from 4.3 are prerequisites.

**8.2 First external connector.** Google, Microsoft, Slack, Teams, or Jira: **one, chosen by partner demand, not five.** Observed sources carry third-party content at volume, which is why 4.3 ships first. Each subsequent connector is its own unit of work with its own eval cases.

**8.3 Projects as workspaces.** Confirmed shape: **projects organize conversations, files, and research runs; memory stays one shared pool.** No third gate dimension on memory, no per-project memory isolation (the audit priced that at 55 to 70 files, a full reindex, two broken published contracts, and an inversion of the existing continuity decision). Per-user private context continues to be handled by the existing scope model. Optionally, a retrieval **filter lens** ("answer from this project's sources") that narrows results without changing the gate. The public wording is fixed and must not drift: *projects organize your work and keep your files and context private; memory stays one connected mind.*

---

## 9. V2.6 and later: platform, gated by evidence

| # | Item | Priority | Difficulty |
|---|---|---|---|
| 9.1 | **Agent governance productization** | P2 | L |
| 9.2 | **Evaluation control plane** | P2 | L |
| 9.3 | **Plugin extension platform** | P2 | XL |
| 9.4 | **Enterprise identity** | deferred | L |

**9.1 Agent governance.** The spine exists (approval state machine, append-only audit log, skills with visible step logs). This is productizing it into a coherent, visible governance layer: policy over which actions require approval, per-action audit views, and the run inspector as a first-class surface. Dual-use for solo and enterprise.

**9.2 Evaluation control plane.** Elevate the harness from a CI gate into an operable surface: run evaluations on demand, compare configurations, track drift over time, and publish from one place. The per-configuration trust-score schema already supports this.

**9.3 Plugin extension platform.** Deliberately last. A plugin system is a security surface, a support surface, and an architectural commitment; it lands on the clean boundaries from 3.6 and the connector platform from 8.1, or it does not land. Scope when reached: extension points (source readers, extractors, actions), a sandboxing and permission model, versioned contracts, and a review posture.

**9.4 Enterprise identity.** SAML, SCIM, LDAP, a richer role model beyond the single admin role, session management. Confirmed **not needed now**; revisit only when a paying enterprise requires it.

---

## 10. Traceability: every confirmed item, mapped

| Confirmed item | Version | Section |
|---|---|---|
| Remove tasks fully, backtraced, no leftovers | V2.0: **delivered** | 3.1 |
| Reminders removed | V2.0: **delivered** | 3.2 |
| Cogeto resolves reviews itself (unsupported/partial automatic) | V2.0: **delivered** | 3.3 |
| Suppressed-fact log (feeds the report) | V2.0: **delivered** | 3.3 |
| Contradictions surfaced, not queued in Review | V2.0 principle, V2.3 depth | 2, 6.1 |
| Enhanced trust score on contradictions, better metrics | V2.0 + V2.3 | 3.4, 6.4 |
| Contradiction precision gated and published | V2.0 | 3.4 |
| Supersedes gated | V2.0 | 3.4 |
| Per-language floors (hr cannot hide in aggregate) | V2.0 | 3.4 |
| Query-rewrite eval cases | V2.0 | 3.4 |
| Evals on PRs via cached responses | V2.0 | 3.4 |
| i18n user-level, en/hr/de, English fallback, keys in sync, library | V2.0 | 3.5 |
| Modularization / cleaner code / less coupling | V2.0 | 3.6 |
| `source_type` enum to registry | V2.0 | 3.6 |
| Audit read coverage incl. passport export | V2.0 | 3.7 |
| Read every document: XLSX/CSV | V2.1 | 4.1 |
| Read every document: OCR for scans (local, en/hr) | V2.1 | 4.1 |
| Read every document: local vision model for hard cases | V2.1 | 4.1 |
| Honest "no readable text" labelling | V2.1 | 4.1 |
| Source-context anchoring (subject, class, revision; editable; re-anchor as supersession) | V2.1 | 4.2 |
| Per-source extraction gate | V2.1 | 4.3 |
| Remove standalone note field and upload from Memories | V2.2 | 5.1 |
| Chat capture only; paperclip file attach; inline "added: N facts, M contradictions" | V2.2 | 5.1 |
| "Don't remember this file" transient toggle | V2.2 | 5.1 |
| Memories becomes Sources: list / source detail / fact detail | V2.2 | 5.2 |
| Exact source span shown per fact | V2.2 | 5.2 |
| Flat memory list demoted to filtered search | V2.2 | 5.2 |
| Bulk import (folder/ZIP/S3, manifest, hash dedup, caps, progress, summary) | V2.2 | 5.3 |
| Contradiction coverage: aliases, typos, cross-language entities | V2.3 | 6.1 |
| Contradiction coverage: 0.80 to 0.93 band and escalation hole | V2.3 | 6.1 |
| Contradiction coverage: numeric and unit conflicts | V2.3 | 6.1 |
| Persist compatible verdicts (checked-pair ledger, stops nightly flip-flop) | V2.3 | 6.1 |
| Supersession interval arithmetic fix | V2.3 | 6.1 |
| Per-embedding-model threshold calibration | V2.3 | 6.1 |
| Timing misses (simultaneous uploads, per-fact budget, uncertain exclusion) | V2.3 | 6.1 |
| Report generator (signed, PDF + JSON, contradictions, superseded, suppressed) | V2.3 | 6.2 |
| Ambiguity detection and fan-out answers | V2.3 | 6.3 |
| Vertical golden set (30 to 50 real document cases) | V2.3 | 6.4 |
| Numeric and cross-language contradiction pairs | V2.3 | 6.4 |
| Authority-ranking cases | V2.3 | 6.4 |
| Provider config in database, encrypted keys, master key in .env, seeded | V2.4 | 7.1 |
| Admin UI for providers; user-switchable chat model; admin-only extraction/verification with trust scores; untested flagged | V2.4 | 7.1 |
| Token counting | V2.4 | 7.2 |
| Counterfactual comparison (cost without Cogeto) | V2.4 | 7.2 |
| Cost reduction / fewer tokens | V2.4 (levers throughout) | 7.3 |
| Observability (metrics, tracing, alerting) | V2.4 | 7.4 |
| Audit logging completeness and retention | V2.0 + V2.4 | 3.7, 7.4 |
| Airgap support hardening | V2.4 | 7.5 |
| Connectors (Google, Microsoft, Jira, Slack, Teams) | V2.5 | 8.1, 8.2 |
| Projects (workspaces, not memory isolation) | V2.5 | 8.3 |
| Enterprise agent governance | V2.6+ | 9.1 |
| Evaluation control plane | V2.6+ | 9.2 |
| Plugin extension | V2.6+ | 9.3 |
| Enterprise identity | deferred | 9.4 |
| Verification before storage | already built; sub-reasons split in V2.0 | 3.3 |
| Temporal validity | already built; supersession fixes in V2.3 | 6.1 |

---

## 11. Sequence and rationale

**V2.0 → V2.1 → V2.2 → V2.3** is fixed. Removal and truth first because the codebase gets smaller and the published numbers get honest before anything is built on them; reading and anchoring next because everything downstream depends on documents being readable and facts knowing their subject; Sources and bulk import next because they are how a corpus gets in and gets proven; findings last in the wedge because contradictions and the report are the payoff and need all three predecessors.

**V2.4 and V2.5** can reorder against evidence: if a design partner needs a connector before cost visibility, swap them. **V2.6 and later** are gated by paying demand, not schedule.

One standing rule for the whole cycle, unchanged from v1: every capability ships with its eval cases, gates ratchet up and never silently down, and the published trust score tells the truth including the parts that are not flattering.
