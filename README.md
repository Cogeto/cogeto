<p align="center">
  <img src="assets/brand/cogeto-final-logo-horizontal.svg" alt="Cogeto" width="360">
</p>

# Cogeto

A private, EU-hosted AI command center that turns scattered work context into trusted, correctable long-term memory — and runs human-approved agents on top of it.

> **Cogeto, ergo sum — your mind, extended.**

## What is Cogeto

Cogeto ingests your scattered work context — email, calendar, notes, documents — and turns it into **correctable, inspectable long-term memory** rather than just stored text. Every fact carries a lifecycle status (active, outdated, contradicted, uncertain, replaced, user-approved) plus an orthogonal sensitive flag, is scope-tagged, and stays source-linked, so you can trust it and correct it. Human-approved agents then act on that memory with a human in the loop.

It is **EU-first, privacy-first, self-hostable, and model-agnostic (Mistral-first)**. The moat is the correctable, inspectable memory — not the storage. Primary users are privacy-conscious solo professionals: consultants, founders, freelancers, and small teams.

## Repo layout

- `project/` — the Cogeto product (skeleton only for now).
- `docs/` — authoritative product specification and scope.
- `assets/` — brand assets (logo, icon); trademarked, see [`TRADEMARK.md`](TRADEMARK.md).

## Status

**Session O3-B complete — the redaction sidecar (`--profile redaction`).** A
per-tenant privacy tier (Addendum B.8): a stateless, CPU-only Python/Presidio
service — the only caller is the model gateway, it touches no database and stores
nothing — pseudonymizes sensitive entities (person, org, location, email, phone,
IBAN, monetary amount, Croatian OIB) **before any external model call** and
re-identifies the response, so *"PII never leaves your box, even though a frontier
model answers you."* A gateway decorator wraps every model path (completion,
extraction, embedding); embeddings are redacted too (decision 0023 — the honest
v1 choice, local embeddings are the v1.x fix), and if the sidecar is unreachable,
model calls **fail closed** rather than sending plaintext. Enable with
`REDACTION_ENABLED=1 docker compose --profile redaction up --build`. Details in
`docs/sessions/O3-B.md` (decisions 0002/0023; no migration). **The rest of O3 — a
broader frontend design pass — is next.**

Previously — **Session O3-A — the Ana sandbox (`--profile demo`).** The public demo
is now the real growth engine (§B.9): `docker compose --profile demo up` provisions
a real, pre-authenticated demo Principal ("Ana Kovač"), feeds ~31 fictional
first-person notes + one uploaded contract **through the real public API**, ages
the world to weeks of accrual, runs one dreaming cycle, and **asserts the end
state loudly** — a contradiction to resolve, lapsed and superseded facts, hedged
memories, derived tasks, and the deletion-receipt document. A subtle sandbox
banner and a dismissible first-visit overlay guide the three demo moments (ask
what Ana promised Marko → resolve the contradiction → delete Ana's contract and
watch the signed receipt confirm, now exportable as a PDF certificate). `npm run
demo:reset` and a demo-only scheduled reset restore it; a production flag refuses
the seed. All fictional, single-tenant, disposable. Details in
`docs/sessions/O3-A.md` (decision 0022; no migration). **The rest of O3 — the
Presidio redaction sidecar and a broader frontend design pass — is next.**

Previously — **Session O2 complete (O2-C: chat-derived memories, seam coverage, corpus).**
Cogeto now turns memory into action and shares it across a team. **Tasks,
reminders, and a unified daily digest** (O2-A): commitments derive tasks with
conditions and closure; a reminders pass (on the one existing scheduler) and a
single digest surface consolidation + tasks, deep-linked and silent when empty.
**Shared scope and a second user** (O2-B): notes and uploads choose private or
shared, an owner-only audited action flips a memory's scope (row + vector payload
together), shared memories are visible org-wide with owner attribution while every
mutation stays owner-only — proven by a cross-user suite (private invisible across
every read path; shared read-only for peers; cross-org isolation by single-tenant
deployment). **Chat-derived memories** (O2-C): a *"remember this"* affordance on a
user chat message routes it through the same verifiable pipeline (`source_type
'chat'`) — never silently, never the assistant's replies; a commitment stated in
chat derives a task exactly like a note, and its source drawer shows the framed
conversation. The **identity and model-gateway seams** are now directly tested
(Principal construction, token rejection, tier selection, retryable-vs-fatal
errors, prompt immutability, and architecture assertions that only each seam
touches Zitadel / Mistral). Golden corpus grew with idiomatic chat-sourced en/hr
cases; all eval gates pass. Details in `docs/sessions/O2-A.md`, `O2-B.md`,
`O2-C.md` (decisions 0018–0021, migrations 0017–0019).

Previously — **Session O1 complete (O1-C: extract-and-discard, Settings, the audit reader).**
The document pipeline now offers **extract-and-discard** (a per-upload flag with
a per-user default): the original is deleted once its facts are extracted — no
durable object, no metadata row — while the derived memories keep full
provenance to the (now byte-less) source, and deleting that source still issues
a signed receipt (covering the memories, zero objects). A minimal **Settings**
surface exposes only real, wired toggles (the discard default, the default
capture/upload scope) plus the read-only instance signing key. And the
**audit trail is finally readable**: a reverse-chronological, filterable,
paginated, org-scoped, *read-only* Audit view closes the write-only-audit gap —
the trust surface can now show who did what, with each entry linking to its
receipt, memory, or approval. Verified live end to end. Details in
`docs/sessions/O1-C.md` (decision 0016, migration 0016). **Session O1 (files,
approvals, audit, discard) is done; O2 — tasks UI, reminders, digest,
shared scope, chat-derived memories — is next.**

Previously — **Session O1-B (the approval state machine — Addendum §A.8).**
Consequential actions are now gated by a real server-side state machine:
`draft → pending_approval → approved → executed` (plus `rejected`, `expired`).
The authenticated confirm endpoint only *transitions state* — on approve it
enqueues a worker job and does nothing else; the effect runs **only in the
worker**, inside the S1-B execution guard (at-most-once), and can run **only
from `approved`**. A front-end dialog is never sufficient. An action-type
registry maps each action to a validated payload schema, a human summary, and a
worker-only effect; the first wired action is an in-system, reversible **bulk
memory outdate** (skips explicitly user-approved memories). A **Pending
Approvals** surface (nav badge, Pending + History tabs) is the sole approval
path; Memories gained a Select → "Request 'Mark outdated' approval" flow. Every
transition is audited; org-scoped so one tenant can't confirm another's; a
5-minute expiry pass ages out stale requests. Verified live end to end through
the compose stack. Details in `docs/sessions/O1-B.md` (decision 0015, migration
0015). Remaining O1 items (audit-log reader/UI, extract-and-discard, minimal
Settings) are for a later session.

Previously — **Session O1-A (file upload + the document pipeline) — the first
Opus/executor session.** Upload a PDF or DOCX beside the capture card and it
enters the *same* verifiable-memory pipeline as a typed note: text is extracted
(`pdf-parse` / `mammoth`), chunked, each fact independently verified, embedded,
reconciled, and governed — no separate path. Uploads are transactional
(object-first, then `file_metadata` + the pipeline job in one commit, with an
abort-window cleanup); a corrupt file reaches a visible `error` state and
fabricates nothing. The original bytes live in MinIO under the scoped
`{orgId}/{userId}/{scope}/file-{uuid}` key with the filename/content-type on the
object itself; the source drawer offers a short-lived signed-URL download
(owner-gated; sensitive files never leave their owner). Deletion is the
existing F1 saga, unchanged — the cascade test now runs against a real uploaded
file, and the nightly sweep stays clean. Verified live end to end through the
compose stack. Details in `docs/sessions/O1-A.md` (decision 0014; no migration).
The remaining O1 work — approval state machine, audit-log reader/UI,
extract-and-discard, minimal Settings — is O1-B.

Previously — **Session F3 complete (temporal retrieval + the task engine) — the
day-one job is answerable end to end at the engine level.** Ask Cogeto the founding
sentence — *"What did I decide, promise, and commit to — and what's still
open?"* — and it answers from **derived tasks**: every commitment and open
loop you capture becomes exactly one task automatically (deterministic — no
model decides *whether*), blocked tasks carry their waiting condition
("waiting on Luka's budget confirmation"), quiet ones are nudged, and a new
fact that shows a promise was fulfilled **closes its task** via a
conservative model judgment whose prompt states the cost table: a wrongly
closed task hides an obligation, so doubt never closes. Tasks follow their
memory through supersession, vanish (counted, on the receipt) when their
source is deleted, and never touch memory themselves — the engine is
read-only toward the memory it derives from, enforced by test and by the
module boundary checker. A provisional Tasks panel ships now; reminders,
digest integration, and the real UI are specified in the frozen
`docs/handoff/F3-tasks.md` for O2 (decision 0013; migration 0014). **The
Fable block (F1–F3) is complete** — next is O1 per the roadmap.

Previously — **Session F3-A (temporal retrieval — time-travel memory).** Cogeto's
memory now answers about the **past as the past**: "what did we previously
decide", "which CRM were we using in March", and "what changed since June"
run through an explicit temporal mode — activated only when the query
genuinely asks about time (deterministic hint lexicon + model classification,
either alone is never enough), with dates resolved by code, never the model.
One frozen interval predicate (`[valid_from, valid_until)` half-open, NULL
means still-holding) drives point-in-time selection over every lifecycle
status; superseded facts return with their successor and are rendered as
muted **"past"** chips, and the answerer is contractually barred from stating
past belief as current ("Until March you had X; since then Y"). Scope and
sensitive gates hold unchanged through time — time travel never crosses
owners. Default retrieval is byte-for-byte unchanged, with a regression eval
case pinning that replaced facts never resurface without temporal intent
(decision 0012; migration 0013).

Previously — **Session F2 (reconciliation + dreaming + gates, F2-A + F2-B).**
Cogeto now **consolidates itself while you sleep and measures itself before it
ships**. The nightly **dreaming** cycle (03:30, after the integrity sweep)
re-runs the reconciliation engine in batch over the day's new facts, marks
lapsed memories outdated deterministically, and flags commitments that went
quiet — never touching a status it isn't entitled to. Its work appears each
morning as a plain **"While you were away"** panel: at most six human-phrased
lines, every one deep-linked to its artifact, silent nights showing nothing
(the tappable chat card is v1.x, contract frozen in the F2 handoff). The
verifier is now calibrated for Croatian (`verification/v0004`: month-name
false friends, present-for-future, colloquial agreement, hedging particles —
hr agreement 57.1% → 81.8%), the golden corpus grew to 30 en / 17 hr items,
and the **§B.4 eval gates are ON**: `npm run eval:gate` and the `eval-gate`
CI workflow fail the build when any aggregate metric drops below the
versioned, ratchet-up-only thresholds in `project/eval/gates.json` — proven
by a degraded-prompt drill that collapsed verification to 8.8% and exited 1
(decisions 0010–0011; migrations 0011–0012).

Previously — **Session F2-A (the reconciliation engine — pipeline stage 6).**
Cogeto's memory now reconciles with itself: every newly admitted fact is
checked against the owner's existing memory — deterministic candidate rules
first (versioned thresholds, zero model calls), then two new versioned prompt
families confirm **duplicates** (`reconcile_dedup/v0001`, biased hard against
merging: a false merge destroys a distinct fact) and **contradictions**
(`reconcile_contradiction/v0001`, biased to compatible: a false alarm wastes
the user's attention). Confirmed duplicates merge by supersession (history
preserved; the user's own confirmations always outrank the machine);
confirmed conflicts mark **both** memories `contradicted` and land in a new
**Review → Contradicted** queue showing both facts and both sources side by
side, with three resolutions: confirm one, correct both, or dismiss —
dismissed pairs are never re-flagged. Explicit updates ("moved to X") apply
supersession only when the direction is unambiguous; every doubt routes to
the human. First measured baseline (14 labeled pairs, en+hr): dedup accuracy
90% with **zero false merges**, contradiction recall 100%, zero candidate
misses (decision 0010; migration 0011).

Previously — **Session F1 (deletion saga + provable forgetting, F1-A + F1-B).**
Cogeto can now **prove it forgot something**: source-level deletion runs as a
saga across Postgres, Qdrant and MinIO and issues a **hash-chained, ed25519-
signed deletion receipt** — permanent (DB-frozen), owner-scoped in the
**Forgotten** section, exportable as a self-verifying JSON artifact. A nightly
integrity sweep re-verifies every confirmed receipt (no rows, no vectors, no
bytes) and the whole chain; violations become alerts that degrade `/api/health`
and light up the System view. MinIO runs with SSE-S3 encryption at rest
(asserted at compose up and in the health check), and each instance signs with
its own key generated at first boot. Operational contracts: `npm run reindex`,
`npm run eval`, `npm run eval:chat`, and now the sweep
(`docker compose exec worker node project/src/dist/entrypoints/sweep.js`).

On top of the Session 1–3.5 foundation (compose stack to login, contractual
schema, outbox + idempotent queue, the six-stage Notes pipeline, hybrid
retrieval, grounded chat, the governance dashboard, and quality hardening):

- **Grounded, complete chat**: conversational query rewriting resolves pronouns
  ("who is she?") against recent turns; an **entity-profile** retrieval mode
  gathers everything about a person and answers with a full profile; project
  questions aggregate the whole picture. Answers describe the world (never the
  retrieval), and a fact about Ana that mentions Marta is never conflated.
- **Deterministic dates**: relative expressions ("by Monday", "in two weeks")
  are resolved by code against the note anchor, not guessed by the model.
- **Honest uncertainty**: hedged source wording ("might", "not sure") admits a
  memory as *uncertain* and is shown with soft framing; plainly stated facts stay
  *active* — the verifier judges support only.
- **Leak-proof citations**: one grammar (`{{cite:uuid}}`); any other bracketed
  token is stripped before it can reach the user.
- **Per-task model tiers**: a cheaper model for high-volume ingestion, a stronger
  one for user-facing answers.
- **Two eval harnesses**: `npm run eval` (golden set, extraction + verification)
  and `npm run eval:chat` (scripted conversations scored end-to-end), both
  recorded to `docs/eval/history.md`.

Next (Session F2): reconcile (dedup/contradiction), the dreaming cycle, and
the CI eval gates — per `docs/Cogeto-Model-Split-Roadmap.md`. File uploads plug
into the deletion saga per the frozen `docs/handoff/F1-deletion-saga.md` (O1).
Retrieval/answer/extraction prompts are versioned artifacts under
`project/prompts/` (currently extraction/verification/answer at v0002).

## Licensing

- **Core** is licensed under **AGPLv3** — see [`LICENSE`](LICENSE).
- **Contributions** require a **CLA** — see [`CLA.md`](CLA.md).
- **Commercial licenses** (AGPL exemption) are available — see [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md).
- The **"Cogeto" name and logo** are trademarks — see [`TRADEMARK.md`](TRADEMARK.md).
