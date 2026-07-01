# Cogeto — v1 Scope & Strategy

*Cogeto, ergo sum — your mind, extended.*
**Private, EU-hosted AI that remembers your context and acts only with your approval.**

This is the lean v1. It deliberately cuts scope from the original vision doc so there is one clear product to ship, one clear user, and one clear reason to pay. Everything cut is listed under "Later," not deleted — it is sequenced, not abandoned.

---

## 1. The one-line product

**Cogeto is a private, EU-hosted AI command center that turns your scattered work context into trusted, correctable memory — and runs human-approved agents on top of it.**

The bet is not "we have memory." Everyone has memory. The bet is **memory you can trust, correct, and inspect, hosted privately in the EU, packaged for people who don't want to operate infrastructure.** No competitor in the memory space leads with that combination.

---

## 2. Who v1 is for

**Primary user: the privacy-conscious solo professional** — consultants, founders, executives, freelancers, small advisory teams. People whose work context (decisions, promises, people, projects, open loops) is scattered across email, calendar, and notes, who would never paste that context into a US hyperscaler's chatbot, and who will pay for someone to host it privately for them.

**Not v1:**
- Not mass-market consumers.
- Not developers as the primary buyer (though developers can self-host — see §7).

This user types. They don't need voice. They need to *trust* what the system remembers about their clients.

---

## 3. The one job v1 does on day one

> "What did I decide, promise, and commit to — across my email, calendar, and notes — and what's still open?"

If Cogeto answers that reliably and privately on day one, it has earned the user. Everything else is expansion.

---

## 4. What ships in v1 (scope: locked)

### 4.0 Interaction surfaces
Cogeto has two surfaces, and both ship in v1. They serve different needs and reinforce each other.

- **Chat (conversational) — the primary, everyday interface.** This is the front door. The user asks things in natural language ("what did I promise Marko?", "what's open this week?", "prepare me for tomorrow's meeting"), and Cogeto answers by retrieving from memory, drafts replies, and proposes tasks and actions (which then go through approval). The fast-path retrieval (§6) lives here, and most usage happens here.
- **Dashboard (structured UI) — the management and governance surface.** This is where the user audits what Cogeto knows: see, search, edit, correct, and delete memories, view status flags, and trace each fact back to its source. It is deliberately not conversational; it is a browse-and-manage view.

The mental model: **chat is how you use your memory; the dashboard is how you govern it.** Most memory products have only the chat. Cogeto's moat (correctable memory) specifically requires the dashboard, because you cannot correct what you cannot see. Neither surface is optional in v1.

### 4.1 Private long-term memory
Cogeto remembers useful context over time: people, projects, decisions, preferences, commitments, important notes, recurring patterns.

### 4.2 Shared & private memory scopes
Every memory carries an `owner_id` and a `scope`. v1 ships two scopes: **private** (visible only to the owning user) and **shared** (visible to others in the same account/team). This makes the agency case work without putting people in one chat: collaboration happens through *shared memory*, not a shared thread. Person A asks "what did we decide on the Luka account" and reads the shared scope Person B contributed to. Scope-addressable memory is a **day-one, non-negotiable data-model decision** — retrofitting it later is a rewrite, so it ships from the first commit. The `sensitive` and `user-approved` quality flags (§4.3) also gate visibility, so scoping and the memory-quality engine reinforce each other.

### 4.3 Memory quality engine — *the moat*
This is the part competitors don't prioritize and the reason Cogeto exists. Every memory is **inspectable, editable, deletable, and source-linked**, and carries a status:

- active
- outdated
- contradicted
- uncertain
- replaced
- user-approved
- sensitive

The product principle, stated plainly: **AI memory must be correctable, inspectable, and allowed to become outdated.** Most memory products only remember. Cogeto remembers *responsibly* — and shows its work.

### 4.5 Identity, logins & SSO — Zitadel from day one
Cogeto uses **Zitadel** as its identity layer from v1, not a deferred add-on. It handles registration, logins, and **SSO** (log in with Google/Microsoft, and enterprise SSO when needed). Rationale: it is AGPLv3 (same license as Cogeto, no compatibility friction), built organizations-first (Instance → Organization → Project → Application — an agency is an Organization, its staff are users), runs as a single Go binary with Postgres (~100MB RAM), and ships a tamper-evident audit trail out of the box that strengthens the approval/audit story.

Critical boundary: **Zitadel answers "who is this user and what org/roles do they have." It does *not* decide which memories they can see.** Memory scoping (§4.2) is Cogeto's own backend logic. The two meet at one seam: Zitadel asserts identity + roles → Cogeto filters memory to the scopes those roles may read. A thin identity abstraction sits between Cogeto and Zitadel so the rest of the system never calls Zitadel directly.

### 4.6 Integrations (v1: three, no more)
- **Email**
- **Calendar**
- **Notes** (manual capture / quick text in)

Three is enough to deliver §3. More connectors are a Later expansion, not a v1 requirement.

### 4.7 Tasks, reminders, digests
Memory turns into action: todos, reminders, follow-ups, an "open loops" list, a daily digest, and meeting prep. Cogeto extracts structure from a quick note — *"Send proposal to Luka after he confirms budget"* becomes person, topic, condition, task, and status.

### 4.8 Human-approved agents (standard, always)
Cogeto can draft emails, prepare replies, summarize documents, organize, suggest next actions, and update memory — but **consequential actions require explicit approval.** Cogeto never sends important messages, deletes data, makes purchases, or acts as the user without confirmation. This is a standard, baked-in behavior, not a sellable differentiator (approval gates are becoming table stakes), but it is non-negotiable for the trust story.

### 4.9 Document ingestion and memory extraction
Cogeto remembers from documents (PDF, DOCX, and similar) and notes through an extraction pipeline, not by dumping raw text into the store. The flow: **ingest** (read raw text; PDFs are text-extracted first), **chunk** (split long documents into manageable pieces for accurate extraction), **extract** (the model pulls durable facts, decisions, people, dates, and commitments into structured data), **embed and store** (each clean fact becomes a vector tagged with scope, source link, and quality status), and **reconcile** (check against existing memories for duplicates and contradictions, updating statuses). The rule: **store the extracted facts, not the raw document, in memory.** A document is read, distilled into a handful of clean memories, and those memories carry a link back to the source. Dumping whole documents into the vector store is the failure mode that pollutes memory quality, so Cogeto avoids it by design.

### 4.10 File storage and deletion
Original uploaded files (the actual PDF/DOCX bytes) are **stored by default** in EU object storage, encrypted at rest, tagged to the owning user and scope (private/shared), and respecting the `sensitive` flag. This makes source-linking literal: a user can click a fact and open the exact source it came from, which directly serves the inspectable, correctable memory moat, and allows later re-processing. Because Cogeto becomes custodian of full sensitive files, deletion is first-class: **deleting a document removes the file and every memory derived from it** (true deletion, not hiding). This requires that every memory record knows its source file from day one, which is the same source-link already being built. An optional **extract-and-discard** privacy mode lets users keep only the derived memories and discard the original file.

**Storage technology: MinIO, accessed via the S3 API.** Files are stored as objects under scoped keys (`tenant/user/scope/file-{uuid}`), with the file's metadata (key, owner, scope, `sensitive` flag, upload date) held as a row in Postgres. Postgres holds the facts and pointers; object storage holds the actual bytes, joined by the file key. MinIO is open-source and S3-compatible, so it drops into `docker compose` for self-hosters and runs alongside each managed instance, keeping files on infrastructure we control (on-brand for "nothing leaves the EU box"). Because the code is written once against the **S3 API**, the same backend can point at MinIO locally, MinIO on a managed instance, or a European S3-compatible cloud (Scaleway, OVHcloud, Hetzner, Exoscale) without a rewrite, per deployment. Retrieval for the user uses short-lived signed URLs. AWS S3 and Cloudflare R2 are deliberately *not* the default, since data-sovereignty clarity is part of the pitch.

### 4.11 Memory dashboard
A clean UI to see, search, edit, correct, and delete memories — with source links back to the email/event/note each fact came from. This is the governance surface described in §4.0: where "correctable memory" becomes visible and where trust is won. It complements the conversational chat, which is where the user asks questions and acts on memory day to day.

---

## 5. Model approach: Mistral-only for now

Cogeto is **Mistral-first** as its European identity, and for v1, **Mistral-only**. Model-agnostic routing (local models, OpenAI/Claude/Gemini, per-task routing) is architecturally kept open but **not built or exposed in v1.** One model, working well, beats a routing layer nobody asked for yet.

### 5.1 Utility-model seam (design now, deploy local later)
All model calls go through a swappable interface, not directly to Mistral. v1 runs everything on the Mistral API, including the high-volume background work (classification, extraction, deduplication, contradiction checks, and memory consolidation, the "dreaming" job). A small local model (for example Qwen 2.5 7B via Ollama, containerized into `docker compose`) is an **optional, later** addition behind this same seam. Its justification is **privacy** (local PII screening so sensitive content never leaves the box, which reinforces the EU story) and **flat, predictable cost at high volume**, not early savings, since at small scale the Mistral API is cheaper than running a box. The local model, if added, owns only behind-the-scenes work (classification, extraction, screening, consolidation) and **never produces the user-facing answer**, which always stays on the primary model. When deployed local, co-locate it on existing infrastructure rather than a dedicated per-tenant box, to protect margin.

---

## 6. Architecture note — why Cogeto is *not* slow

The original concern: doing memory "responsibly" (contradiction checks, status tracking) is more work per memory, so it might feel slow. It won't, because of one rule:

**Separate the fast path from the slow path.**

- **Fast path (synchronous, instant):** retrieval and answering. When the user asks something, Cogeto does hybrid retrieval and responds immediately. The user never waits on memory maintenance.
- **Slow path (asynchronous, background):** extraction, deduplication, contradiction detection, and status updates run *after* the response is delivered, as background jobs.

So the "responsible" work — the moat — happens off the critical path. The user feels a fast assistant; the trust machinery runs quietly behind it. This is a hard architectural commitment, not an optimization to add later.

---

## 7. Deployment

Cogeto has two paths in v1, with clear priority:

**A. Managed hosted instance — *the focus.*** We spin up a dedicated, isolated Cogeto instance per customer on EU infrastructure. The user installs nothing. This is "your own private instance," not "a seat in our SaaS." Single-tenant isolation is itself the privacy story.

**B. Self-hosted (open source) — *available, unsupported, not promoted.*** The code is public and documented; anyone technical who wants to run their own via Docker can. We do not market to them, build onboarding for them, or support them in v1. It exists for trust, transparency, and community — proof Cogeto is not a black box. Normal users will not install Docker, and we don't ask them to.

---

## 8. Business model

A protected open-core, with hosting as the revenue engine.

### 8.1 Open-source core — for trust, under a protective license
The core is open source (see §9 for the license). This buys credibility, transparency, the EU/privacy posture, and "not a black box." It is positioned as proof, not as the product.

### 8.2 Managed private instances — the recurring revenue
Customers pay a recurring fee for a dedicated EU-hosted instance that we operate. This is the core business. Pricing is per-instance, not per-seat — reinforcing "your private instance."

### 8.3 Trials — how people commit
A **14-day free trial on a real spun-up instance.** Real data, real value, converts to a paid instance. This fits the "we host it for them" model exactly and lets the trust build over days, which is the only timescale on which memory value becomes visible.

### 8.4 Demo — replace the public demo with a sandbox persona
A live, open-ended public demo is the wrong format for a memory product: memory only becomes valuable after days of accumulation, so a stateless 2-minute demo shows nothing. Instead:

> **A pre-populated sandbox persona.** "Meet Ana, an independent consultant. Ask her Cogeto: *What did Ana promise Marko? What's open this week? Prepare Ana for tomorrow's meeting.*"

The visitor instantly sees what *accrued, correctable memory* looks like — the payoff — without spending a week to get there. It also showcases the memory dashboard (editing, source links, status flags) on safe fake data. This is the public-facing "demo"; the trial is the real thing.

### 8.5 Enterprise — *Later*
Deeper private deployment, advanced compliance certifications, dedicated admin console, and fine-grained team roles beyond private/shared. (Basic logins and SSO are already in v1 via Zitadel — see §4.5.) Real revenue eventually, but the depth is not a v1 distraction.

### 8.6 Agency / CTO services — *Later, and treat as a bridge*
Useful to fund the product early, but it cannibalizes product focus — it's how a product company quietly becomes a consultancy. Acceptable as a bootstrapping bridge; not the business. Keep it explicitly time-boxed.

---

## 9. License & IP protection: the four-layer stack

**Recommendation: AGPLv3 + CLA + commercial licensing + trademark.** Each layer protects a different thing; together they are the standard protected open-core playbook (GitLab, Grafana, Mattermost). Not MIT — MIT is maximally permissive and gives **zero protection**: a competitor or cloud provider could take the code, wrap it in a closed managed service, and compete using your own work. For a project whose value *is* the hosted business, that's the wrong choice.

### Layer 1 — AGPLv3 (protects the code)
- **Genuine, OSI-approved open source** — fully preserves the trust / transparency / EU posture.
- Its network clause means **anyone running Cogeto as a service must publish their modifications.** This makes fork-and-close commercially unattractive and protects your hosted business.

### Layer 2 — CLA (enables everything below)
- Contributors assign you rights to their contributions, so **you remain legally free to relicense.** Without a CLA you cannot dual-license other people's code. This layer is what *enables* commercial licensing.
- **Get it in place from commit #1** — retrofitting a CLA across existing contributors is painful.

### Layer 3 — Commercial license (the enterprise upsell)
- You sell an **AGPL exemption** to enterprises that can't accept its obligations. The CLA makes this possible.
- No need to build this early — stand it up when an enterprise actually asks.

### Layer 4 — Trademark (protects the name — the layer most founders forget)
- Protects the **name "Cogeto" and the logo** separately from the code. AGPL lets someone *run* your code; trademark means they **cannot call their version "Cogeto."** They'd have to rebrand, which kills their ability to free-ride on your reputation.
- Often the strongest *practical* moat. **File early in priority markets — EU first**, given the positioning.

### The tradeoff to keep in mind
AGPLv3 scares off some corporate contributors and users with blanket "no AGPL" policies. Since the business is hosting, not community contributions, that cost is worth paying. If priorities later shift toward maximizing adoption and ecosystem, relax the core to Apache-2.0 — but keep the CLA and trademark regardless.

---

## 10. Competitive position

The established players in the AI-memory space are all the same shape: a free open-source library plus a paid managed cloud (the real business). One leads with cloud-first personalization and hyperscaler distribution; one with temporal knowledge graphs, now mostly SaaS; one is an OS-style agent runtime, fully self-hostable.

What none of them lead with — and where Cogeto wins:
- **EU-hosted, privacy-first by default** (they require extra work for data sovereignty / EU AI Act).
- **Correctable, inspectable memory as the headline** (the field is split: some accumulate everything, others invalidate facts — Cogeto makes *user-correctable* memory the product, not a side effect).
- **Packaged for non-technical professionals**, hosted for them, not shipped as developer tooling.

Cogeto should not try to out-engineer them on the raw memory primitive. The win is the **product layer + EU/privacy/trust posture they structurally won't prioritize.**

---

## 11. What's explicitly Later (sequenced, not abandoned)

- Voice (speak/dictate/spoken answers)
- More integrations (WhatsApp/Telegram, Slack/Teams, Drive/OneDrive, Notion, GitHub/GitLab, files/PDFs)
- Model-agnostic routing (local models, OpenAI/Claude/Gemini, per-task routing)
- Mass-market / "normal user" positioning
- Enterprise deployment depth (advanced compliance certifications, dedicated admin console, fine-grained team roles beyond private/shared)
- Agency / fractional-CTO services (bridge revenue only)

---

## 12. The moat, restated

Cogeto's moat is the combination, not any single piece:

1. private long-term memory
2. correctable / inspectable memory quality (status: active, outdated, contradicted, replaced…)
3. human approval as standard
4. EU-hosted, privacy-first deployment
5. user-friendly product hosted *for* the user, not developer tooling
6. shared/private memory scopes with identity + SSO (Zitadel) built in from day one
7. protected open-core (AGPLv3 + CLA + commercial licensing + trademark)

> Most AI memory products remember. **Cogeto remembers responsibly.**
