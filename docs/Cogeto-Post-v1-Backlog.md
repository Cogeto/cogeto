# Cogeto — Post-v1 Backlog (prioritised)

**Status: PLANNING.** For Confluence and the repository. This sits under the Post-v1 Plan (Releases A to D) and turns it, plus the latest working notes, into an ordered, sized backlog. Sizes are S (days), M (a week or so), L (multi-week). Priority reflects value per unit of effort and dependency order, not calendar dates. Nothing here overrides v1; it begins after v1.0.0.

Two framing facts carried from the discussion: several of these are smaller than they look because v1 already built the hard part, and the model-provider work (bring-your-own-key, then local) is one coherent workstream, not two unrelated features.

---

## Priority 1 — Finish the task loop (S, do first)

**Status: DELIVERED** (2026-07-21, issues #167/#168 — decisions 0037/0038, migration 0025; notes in docs/notes/task-conclusions.md and docs/notes/chat-create-task.md).

Completes the founding promise; both halves are largely built in v1 and need their last piece.

**1a. Task conclusion becomes memory.** Today a task tracks its condition and closure (a later fact can flip a blocked task to open, or close it), but that conclusion lives only as task state. This change: when a condition is met or a task completes, Cogeto derives a fact about it ("the proposal was sent to Marko on 14 July, closing the commitment made on 2 July"), with system provenance linked to the source that closed it, entering the normal pipeline. Effect: retrieval, dreaming, and future answers become aware of completions, not just open items. Why first: it closes the exact gap in the "what did I decide, promise, and commit to, and what is still open" story, and it is days of work on existing machinery.

**1b. Create a task from chat.** Commitments captured from chat already derive tasks; what is missing is an explicit conversational intent to make one from the conversation itself, referring to earlier turns ("make a task to send Ana the revised mapping once she confirms the format"). This change: a create_task chat intent that assembles the referenced turns, runs them through the existing commitment extraction and task derivation, and confirms with a link; it asks when the reference is ambiguous rather than guessing. Effect: tasks can be created in the flow of thinking, not only captured from written sources. Complexity: S, same pattern as the existing reply-draft and open-loops intents.

---

## Priority 2 — In-app notifications and dashboard (S to M, standalone)

**Status: DELIVERED** (2026-07-21, issues #170/#171 — decision 0039, migration
0026; notes in docs/notes/dashboard-notifications.md). The dashboard is now
attention-first: `GET /api/attention` serves a computed, Principal-gated feed
(due/overdue, gone-quiet, review, approvals, last night's digest) with an honest
unread indicator (`/api/attention/seen`, per-item dismissal for digest lines
only); `GET /api/dashboard/stats` serves cheap, bounded, gated statistics
(memory-by-status, task load, 30-day sources + dreaming series, oldest review
item). The redesigned home renders a dark instrument hero over hand-rolled SVG
charts (no new dependency). Outbound email notifications remain out of scope.

Deliver the "what needs my attention" surface inside Cogeto itself, not over email. This supersedes the earlier Release A email-notification framing: rather than depend on outbound mail and its deliverability problems, make the dashboard the place the user sees what is due, open, gone quiet, and what changed overnight.

**What.** A notifications and attention surface in the Cogeto dashboard: what is due, what is open, what has gone quiet, what last night's consolidation changed, and anything waiting for approval. A clear unread/attention indicator so the user knows there is something to look at when they open Cogeto, and a calm, scannable digest view (building on the existing daily digest panel from dreaming and tasks) as the home of it.

**How.** No email, no outbound mail service, no subprocessor. The surface is assembled from data the instance already produces: the dreaming digest, task due-dates and dormancy flags, the contradicted and uncertain queues, and pending approvals. A lightweight in-app notification record (or a derived view over the existing signals) drives the attention indicator; opening the dashboard clears or updates it. Everything stays inside the tenant's box with zero new external dependency.

**Why in-app rather than email.** It avoids the whole deliverability problem (cold cloud IPs, SPF/DKIM/DMARC/PTR per instance, spam-folder risk) and adds no subprocessor, keeping the sovereignty story clean. The user lives in the dashboard already; the job is to make that first screen answer "what needs me right now" at a glance. Outbound email notifications, if ever wanted, remain a later optional convenience, never a dependency, and are out of scope here.

**Scope guard.** In-app only. No mail is sent. Reply drafts still go to the user to send from their own client.

**Complexity.** S to M. Standalone, no dependency on anything else, mostly composition and presentation over signals that already exist, and high daily value for little work after Priority 1.

---

## Priority 3 — Model provider gateway: bring-your-own-key (M)

**Status: DELIVERED** (2026-07-21, issues #173/#174/#175 — decision 0040; notes
in docs/notes/model-providers.md). OpenAI-compatible + Anthropic adapters
behind the seam, per-tier provider configuration validated at boot with a
stable configuration id, read-only Settings display, and per-configuration
eval emission (owner-run for alternate providers). The OpenAI-compatible base
URL is the doorway Priority 4 walks through.

Makes the website's "plug in any model" claim literally true, and lays the groundwork for local models.

**What.** The model gateway, today Mistral-only behind a provider-neutral seam, gains adapters for OpenAI-compatible and Anthropic APIs. The active provider and models are set per instance in configuration; a Settings screen displays which provider and models are active (a read-only status, not a key-input form).

**Key handling, decided.** Keys stay operator-set in the instance environment, not entered through the UI. Single-tenant means there is no per-user key isolation to solve, a key-input UI would add encrypted-secret surface for little gain, and the buyer is not asking to paste keys. Settings shows the configuration; it does not capture secrets.

**How it is proven.** The eval harness runs per provider configuration, and each configuration is published on the trust page as its own entry (the schema was built for this). This turns "model-agnostic" from a claim into published, comparable evidence.

**Complexity.** M. The seam exists; this is adapter work plus configuration plus the Settings display. Shares its foundation with Priority 4, so do them adjacently.

---

## Priority 4 — Local models via Ollama (L, Release B)

The sovereignty and economics foundation. Directly extends Priority 3: a local runtime is just another gateway provider.

**What and how.** An Ollama-class adapter behind the same gateway, speaking to a local model runtime on the instance. Migration is staged and eval-gated, never wholesale: local embeddings and reranking first, then the utility tasks (classification, deduplication and contradiction confirmation, verification), then optionally a local answer model. Each task moves to local only when the local configuration reaches eval parity per language on that task, and each configuration is published on the trust page.

**Why it matters beyond privacy.** It is economic infrastructure: Priority 5 and 6 make conversation and research routine, which turns model spend from bounded into open-ended against flat per-instance pricing. Local inference is what keeps that affordable. So this is not only for the customer who demands zero external calls; it is what makes the assistant releases sustainable.

**Complexity.** L, but staged: each tier of local adoption is shippable on its own once it passes parity, so value arrives incrementally rather than in one big bang.

---

## Priority 5 — Web research with query minimisation (L, Release C1)

The research capability, with the privacy honesty improvement from the notes folded in.

**Architecture.** No crawler. Discovery is a self-hosted SearXNG container inside the instance (queries public engines, returns URLs, no API key, no vendor, no query logging, roughly 100 to 200 MB RAM, zero cost). Retrieval is a narrow Cogeto-owned fetcher that pulls selected pages, extracts readable content, respects robots, and caps page count. Extracted text enters the existing pipeline and becomes facts with URL provenance, verification, statuses, and validity intervals, ageing and superseding like any other source.

**Query minimisation (the redaction idea, in its correct form).** Pseudonymising a query breaks it, so instead a redaction-tier pass rewrites the query to the least-identifying form that still serves the intent, keeping an entity only when researching that entity is the point. Combined with the show-edit-approve step, the honest claim becomes: Cogeto minimises what leaves, shows you exactly what leaves, and lets you approve or cancel it before it goes, then records the sent query in the resulting memory's provenance.

**Controls that keep it economical.** Explicitly invoked, never ambient. Extraction on the small pipeline tier; only final synthesis on the answer tier. Hard per-research and per-day caps using the existing budget infrastructure. A few cents per research today, near zero once Priority 4 lands.

**Complexity.** L. New container, fetcher, extraction path, the minimisation prompt, and the approval UI.

---

## Priority 6 — Natural conversation (L, Release C2)

The assistant surface, affordable once local models exist.

**What.** The user talks to Cogeto as they would to any capable assistant; it draws on memory, on the web when asked, and on the model's own knowledge, without a query syntax.

**The rule that protects the thesis.** Provenance is per claim and always visible: memory answers cite memories, research answers cite URLs, and anything from the model's own knowledge is visibly marked as unsourced. That marking is the feature, not a limitation: Cogeto becomes the only assistant that tells you, sentence by sentence, what it can prove. Never positioned as a private ChatGPT.

**Sequencing.** After Priority 4 for economics, or alongside it with the margin hit accepted knowingly. Trigger: Phase 0 or early usage shows users leaving Cogeto to ask another assistant.

**Complexity.** L.

---

## Priority 7 — Named skills (L, Release D)

The visible payoff, built on the research engine from Priority 5.

**What.** Two or three skills that each do a whole job end to end and leave memory and an artifact behind: research a company before a meeting; prepare me for tomorrow; the weekly review of what moved, stalled, and is owed. Each shows its steps, cites everything, and routes consequential actions through approval.

**The claim only Cogeto can make.** The approval machine and audit log existed before there was anything to govern, so these are agents whose every step is inspectable, every fact sourced, and every consequential action waits for you. Competitors cannot enter that category without rebuilding their foundations.

**Complexity.** L. Ship one skill well before adding the next.

---

## At a glance

| # | Item | Release | Size | Depends on | Core value |
|---|---|---|---|---|---|
| 1a | Task conclusion becomes memory | v1.x | S | none | Finishes the founding promise |
| 1b | Create task from chat | v1.x | S | none | Tasks in the flow of thinking |
| 2 | In-app notifications + dashboard ✅ delivered | v1.x | S to M | none | Daily touch; no email dependency |
| 3 | Bring-your-own-key providers ✅ delivered | v1.x/B groundwork | M | none | Makes model-agnostic claim true |
| 4 | Local models via Ollama | B | L (staged) | 3 | Sovereignty + economics foundation |
| 5 | Web research + query minimisation | C1 | L | 4 for economics | The research capability, privately |
| 6 | Natural conversation | C2 | L | 4 | The surface users live in |
| 7 | Named skills | D | L | 5 | The visible, inimitable payoff |

**Order to build:** 1a and 1b together first (small, high value, no dependencies), then 2 (standalone, high daily value), then 3 and 4 as one model-provider workstream (BYOK into local), then 5 and 6 as the assistant, then 7. Reorder only against Phase 0 evidence, and only 5/6-before-4 with the margin numbers in hand.

---

## Standing rules (unchanged)

Every capability ships with its eval cases. Gates ratchet up, never silently down. The trust scores tell the truth, dips included, with explanations. Audits re-run and published at milestones. Decisions of consequence get decision records. One operator, manual by design, until the evidence says otherwise.
