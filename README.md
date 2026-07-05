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

**Session F3 complete (temporal retrieval + the task engine) — the day-one
job is answerable end to end at the engine level.** Ask Cogeto the founding
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
