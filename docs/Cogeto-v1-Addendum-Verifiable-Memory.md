# Cogeto — v1 Addendum: Architecture Decisions & Verifiable Memory

*Companion to `Cogeto-v1-scope.md` and `Cogeto-v1-Specification.docx`. This document does two things: (Part A) records architecture decisions that were open or under-documented in the base spec, closing the gaps found in the architecture audit; (Part B) adds the **Verifiable Memory** feature set — the accepted product-layer innovations that turn every trust claim into an inspectable artifact. Where this document conflicts with the base spec, this document wins (it is newer and resolves the base spec's open points).*

**Status:** Accepted. Decisions in Part A are binding for implementation. Features in Part B carry explicit sequencing tags: `[v1]`, `[v1.x]`, `[Later]`.

**The thesis, extended:** the base spec says *Cogeto remembers responsibly*. This addendum makes that claim provable. Every trust promise ships with a corresponding artifact — a receipt, a diff, a score, an export, a published prompt. **Verifiable memory** is the category position: not "trust us," but "check for yourself."

---

## Part A — Architecture decisions (binding)

### A.1 Topology: modular monolith, DDD boundaries

The spec's component table (§4.5 of the Specification) describes **code boundaries, not deployable services.** Per tenant, exactly **two application processes** are deployed:

- **app** — web (chat + dashboard), API, connectors, approval endpoints.
- **worker** — all slow-path jobs (extraction, dedup, contradiction checks, consolidation/dreaming, reminders, deletion sagas).

Both are built from one codebase organized as **DDD bounded contexts** (modules): `memory` (core domain), `ingestion`, `retrieval`, `agents`, `connectors`, `tasks`, `identity` (Zitadel seam), `model-gateway` (Mistral seam). Module rules, enforced by import-linting / architecture tests in CI:

1. Each module exposes exactly one public interface; internals are private.
2. **No module reads or writes another module's tables.**
3. Cross-module communication uses domain events via the Postgres outbox (§A.3) — the same mechanism as the job queue. One mechanism, not two.
4. Aggregates own their invariants. The `Memory` aggregate owns status transitions: only reconciliation may set `contradicted`; only the user may set `user-approved`; only the deletion saga may hard-delete.
5. Tactical DDD is applied where invariants live (aggregates, repositories); plain services elsewhere. No ceremony for its own sake.

**Rationale:** single-tenant instances make per-service containers a margin killer. Per-tenant compose is ~5 containers (app, worker, Postgres, Zitadel, MinIO, Qdrant), not 10+.

### A.2 `docker compose up` is the contract

One command on a fresh clone must yield a working stack reaching a usable login. Requirements:

- Healthchecks on every service; `depends_on: condition: service_healthy` for ordering.
- Migrations run as a **one-shot init container**, not on app boot.
- Zitadel bootstrapped via provisioning config: first org, first admin, OIDC app registered — zero clicks.
- MinIO bucket creation as an init job.
- Compose profile `--profile demo` seeds the **Ana sandbox persona** (§B.9).
- A fresh clone that does not reach login in one command is a broken build.

### A.3 Job queue: Postgres-backed, outbox pattern, idempotent

- **Technology:** a Postgres-based queue (Graphile Worker for TypeScript, River for Go, or `SELECT … FOR UPDATE SKIP LOCKED` if zero-dependency is preferred). No Redis, no RabbitMQ — fewer moving parts per tenant.
- **Transactional enqueue (outbox):** ingesting a source event and enqueueing its processing job happen in **one transaction.** Nothing can be ingested and silently unprocessed.
- **Idempotency is mandatory from v1.** Idempotency key: `(source_type, source_id, job_type)`. Retries with backoff; dead-letter table with dashboard visibility.

### A.4 Qdrant: index, not truth

Qdrant stays (production posture accepted), under two binding rules:

1. **Postgres is the source of truth.** Memories, statuses, scopes, provenance, validity intervals live in Postgres. Qdrant holds vectors plus a **payload copy** of `owner_id`, `scope`, `status`, `source_id` — nothing exists only in Qdrant.
2. **A `reindex` command rebuilds Qdrant from Postgres**, present from day one. It is the disaster-recovery path and the migration path in one.

**Filtering:** scope and status are applied as **Qdrant payload filters inside the vector query** (payload indexes on `owner_id`, `scope`, `status`). App-side post-filtering of vector results is forbidden — it is the leak-prone failure mode.

### A.5 Retrieval (restores the missing §4.4 of the scope doc)

Hybrid, fused, filtered:

- **Signals:** semantic vector search (Qdrant) + keyword/full-text (Postgres FTS) + entity match (trigram on people/projects). Fused with reciprocal rank fusion.
- **Hard gates (WHERE-clause, never score penalties):** `scope` and `sensitive`. A demoted leak is still a leak.
- **Status as score multipliers on top of gates:** `active` ×1.0, `user-approved` ×1.0, `uncertain` ×0.6, `contradicted` ×0.4 **surfaced with a visible warning**, `outdated` ×0.2, `replaced` ×0 (excluded from default retrieval).
- **Temporal queries** ("what did we previously decide?") explicitly lift the `outdated`/`replaced` exclusion. This is the retrieval face of time-travel memory (§B.2).

### A.6 Data model commitments (migration 0001)

- `memory`: `id`, `owner_id NOT NULL`, `scope enum('private','shared') NOT NULL`, `source_type NOT NULL`, `source_id NOT NULL`, `status enum(7) NOT NULL DEFAULT 'active'`, `valid_from`, `valid_until` (§B.2), `content`, embedding ref, timestamps.
- **Provenance is NOT NULL, always.** Manually authored memories are not an exception: user-typed facts carry `source_type = 'user_note' | 'chat'` pointing at the originating message/note row. "The user told me directly" is provenance. Every fact in the dashboard has a source — no orphans, ever.
- `file_metadata`: `object_key`, `owner_id`, `scope`, `sensitive`, `upload_date`, checksum.
- **Object key first segment ("tenant") = Zitadel organization ID.** Never a constant — keys must stay stable if small tenants are ever consolidated onto shared infrastructure.

### A.7 Deletion saga (how "true deletion" stays honest with Qdrant)

Deletion of a document is a saga, not a wish:

1. **One Postgres transaction:** delete derived memory rows, delete file metadata, write a deletion receipt row with status `pending`, enqueue Qdrant point-deletion via the outbox.
2. **Worker** deletes the vectors in Qdrant with retries; deletes object bytes in MinIO.
3. Receipt flips to `confirmed` **only after Qdrant and MinIO acknowledge.**
4. **Nightly reconciliation sweep** verifies no orphan points/objects exist for confirmed receipts; discrepancies alert.
5. The cascade has an automated test (bytes + metadata + memories + vectors + receipt) as a definition-of-done gate.

### A.8 Approval gate: server-side state machine

Consequential actions (send message, delete data, external write, bulk memory change) persist as rows in a `pending_approval` state machine: `draft → pending_approval → approved → executed` (plus `rejected`, `expired`). Execution happens **only** in the worker, reading `approved` rows created via an authenticated confirm endpoint. A front-end confirm dialog alone is non-compliant. Every transition is audit-logged.

### A.9 Encryption & privacy modes

- **At rest, v1:** MinIO server-side encryption + full-disk encryption on the host. Application-level envelope encryption is `[Later]` — the v1 threat model is answered by single-tenant isolation + SSE + disk encryption. Do not gold-plate.
- **Extract-and-discard:** implemented as a **per-upload flag with a per-user default setting** (not instance-wide config).

### A.10 Model layer updates

- **Primary model:** Mistral API, unchanged. State Mistral's EU/zero-retention DPA terms explicitly on the privacy page.
- **Redaction mode `[v1]`:** see §B.8 — a CPU NER layer, *not* a local LLM.
- **Local embeddings + reranker `[v1.x]`:** a multilingual embedding model (BGE-M3 class) and a small reranker run on CPU at near-zero cost. Embedding is the highest-volume model call in the system — this is the biggest early privacy + cost win, well before any local LLM.
- **Local utility LLM `[Later]`:** the spec's "Qwen 2.5 7B" reference is superseded. Current pick when volume justifies it: **Qwen3-8B** (Apache 2.0, ~5–6 GB Q4, strong multilingual — fits the spec'd CPU box); alternative with more headroom: **gpt-oss-20b** (Apache 2.0, 16 GB). Gemma-family models are excluded on license grounds (non–Apache terms conflict with the open-core licensing story). Re-verify the model landscape at deployment time. Task boundary unchanged: local handles classification, dedup confirmation, verification passes, digest summarization — **never** the user-facing answer, and never primary extraction until eval numbers (§B.4) prove parity.

### A.11 Build sequencing

Vertical slice on **Notes first** — zero OAuth friction, exercises the entire pipeline (ingest → extract → embed → reconcile → retrieve → dashboard → deletion cascade) and unlocks the Ana sandbox before any consent screen. Then **calendar** (non-restricted scopes), then **email last**. The Gmail decision (fund the CASA restricted-scope assessment vs. launch email via Microsoft Graph + IMAP and add Gmail when CASA clears) must be made **now** — it gates the launch date more than any code.

The **eval harness (§B.4) is built alongside the extractor, not after it.** Extraction quality is the product.

---

## Part B — Verifiable Memory: the feature set

*Design rule for everything below: each feature produces a **shareable artifact.** If a trust claim has no artifact, it is marketing; if it has one, it is product.*

### B.1 Deletion receipts — provable forgetting `[v1]`

When a document (or memory) is deleted, the user receives a **signed, audit-logged deletion receipt**: source name, N derived memories purged, N vectors purged, N bytes removed, `pending → confirmed` timestamps, verification method (saga acknowledgment + nightly sweep, per §A.7).

- Receipts are permanent records in the dashboard (a "Forgotten" section) and exportable as PDF/JSON.
- Receipt integrity: each receipt is hash-chained to the previous one (tamper-evident log), signed with an instance key.
- **Why it leads:** no AI product on the market can *prove* it forgot something. It is a demo moment, a GDPR Art. 17 story, and the launch headline ("the AI memory that can prove it forgot you") in one feature — built almost entirely from machinery §A.7 already requires.

### B.2 Time-travel memory `[schema v1, UI v1.x]`

Every memory carries validity intervals (`valid_from`, `valid_until`) in addition to status. Status transitions never destroy history — a superseding fact closes the old interval and opens a new one.

- `[v1]` — schema + interval maintenance in reconciliation; temporal retrieval ("what did we previously decide on X?") per §A.5.
- `[v1.x]` — **memory diff view** in the dashboard: "what did I believe about the Luka deal in March, and what changed since?" — a timeline per entity/project, with each change traceable to the source that caused it.
- Positioning: *your memory has an undo history.* Temporal knowledge exists in developer tools; nobody has made it legible to an end user.

### B.3 Self-verifying extraction `[v1]`

Every extracted fact gets a second, **independent** verification pass before it is stored as `active`: *"Does the cited source actually support this claim?"* — a cheap model call with the fact + source excerpt, answering supported / unsupported / partial.

- Unsupported or partial → status `uncertain` automatically, flagged for user review in the dashboard.
- The verifier uses a different prompt (and, when available, a different model tier) than the extractor — no grading your own homework with the same rubric.
- Verification outcomes feed the trust score (§B.4). This is what makes the seven status flags **earned**, not decorative.

### B.4 Published trust score `[harness v1, public page at launch]`

The eval harness is a product feature, not internal tooling:

- **Golden set:** 50–100 hand-labeled notes/emails/events with expected memories (per language served). Grows with every real-world failure case.
- **Metrics:** extraction precision/recall, dedup accuracy, contradiction-detection precision/recall, verification-pass agreement rate.
- **CI gate:** no release ships below thresholds; prompt or model changes that regress the golden set fail the build.
- **Public page:** metrics published per release, like an uptime page. An AI memory vendor publishing "here is how often we're wrong" is unheard of, perfectly on-brand, and what makes compliance-minded partners lean in.

### B.5 Memory Passport `[v1.x]`

One-click export of **everything**: facts, statuses, provenance links, validity history, deletion receipts — in an open, documented, versioned format (JSON schema published in the repo). Import is `[Later]`; export is the promise.

- Positioning: *your memory is portable; leave whenever you want.* The loudest possible anti-lock-in signal, nearly free because the schema (§A.6) already contains all of it.

### B.6 Dreaming digest `[v1.x]`

The nightly consolidation job ("dreaming") surfaces its work as a **morning card in chat** — three lines maximum, e.g.:

> Merged 4 duplicate facts about Luka · Your March pricing note now looks outdated · 2 open loops went quiet this week

Each line is tappable through to the exact dashboard item (the merge, the flagged memory, the open loops). Constraints: never more than one card per day; silent nights produce no card; every claim in the card links to its artifact. This is the trust machinery making itself visible as a daily ritual — background inference turned into product.

### B.7 Prompts as versioned, published artifacts `[v1]`

Every system prompt that decides what Cogeto remembers (extraction, verification, dedup, contradiction, consolidation) is:

- **Versioned in the repo** like a migration — numbered, immutable once released, changelog required.
- **CI-evaluated** against the golden set; the eval score of the active prompt version is recorded.
- **Public** (the core is open source anyway): "here is the exact prompt that decides what we remember about you, and its measured accuracy" — verifiable memory extended into the model layer.

### B.8 Redaction mode `[v1]`

A per-tenant toggle: sensitive entities (names, amounts, health/legal/financial terms) are detected **locally on CPU** (Presidio / GLiNER-class NER — ~1 GB RAM, milliseconds, no GPU, no local LLM), pseudonymized before any external API call, and re-hydrated in the response.

- Marginal cost ≈ zero inside containers each tenant already runs.
- Pitch: *"PII never leaves your box, even though a frontier model answers you."* This is the privacy tier for the exact v1 persona — paranoid but non-technical.
- Three-tier model story, stated once: **(1)** default = Mistral API under EU DPA terms; **(2)** toggle = redaction mode in front of tier 1; **(3)** BYO model endpoint via the model-gateway seam (self-hosters/enterprises; already architecture, no extra infra).

### B.9 Ana sandbox `[v1, early — not last]`

The public demo (base spec §8.4) is promoted to a **growth engine** and built early via the `--profile demo` compose profile (§A.2): pre-populated persona, accrued memory, the dashboard with statuses and source links, and — critically — a **live deletion receipt demo** ("delete Ana's contract; watch the receipt confirm"). No signup. It is the only way a memory product is feelable in 60 seconds, and it is the link in every pitch, post, and partner email.

### B.10 Compliance one-pager `[v1, one weekend]`

Not certifications (SOC2/ISO stay `[Later]`) — a crisp public page: data-residency map, encryption posture (§A.9), deletion guarantees with a sample receipt, subprocessor list (Mistral + EU host, nothing else), and a short mapping of Cogeto's artifacts to GDPR articles and EU AI Act transparency duties. This is the PDF a design partner forwards to their compliance officer. It unblocks most procurement conversations at target-customer size for the cost of a weekend.

---

## Sequencing summary

| Item | Tag |
|---|---|
| Migration 0001 (scope, provenance NOT NULL, 7-state status, validity intervals) | v1, first |
| Outbox + pg job queue, idempotent workers | v1 |
| Deletion saga + receipts (+ cascade test) | v1 |
| Server-side approval state machine | v1 |
| Hybrid retrieval, payload pre-filters, status multipliers | v1 |
| Self-verifying extraction | v1 |
| Eval harness / golden set (built with the extractor) | v1 |
| Versioned public prompts | v1 |
| Redaction mode (CPU NER) | v1 |
| Ana sandbox (`--profile demo`) | v1, early |
| Compliance one-pager | v1 |
| Notes → Calendar → Email connector order; Gmail/CASA decision | v1, decide now |
| Trust-score public page | launch |
| Time-travel diff UI | v1.x |
| Memory Passport (export) | v1.x |
| Dreaming digest card | v1.x |
| Local embeddings + reranker | v1.x |
| Local utility LLM (Qwen3-8B / gpt-oss-20b), Passport import, envelope encryption, SOC2/ISO | Later |

---

## The moat, restated (superseding base spec §12)

Cogeto's moat is **verifiable memory** — every trust claim backed by an inspectable artifact:

1. Forgetting → **deletion receipt**
2. Change over time → **memory diff / undo history**
3. Accuracy → **published trust score**
4. Honesty of extraction → **self-verification + earned status flags**
5. No lock-in → **Memory Passport**
6. Transparency of the machine → **published, versioned prompts**
7. Privacy in transit → **redaction mode**, EU-only path
8. All of it felt in 60 seconds → **the Ana sandbox**

> Most AI memory products remember. Cogeto remembers responsibly — **and can prove it.**
