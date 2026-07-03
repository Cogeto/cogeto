# Session S3-B — the governance dashboard

**Date:** 2026-07-03 · **Scope:** S3-B owner prompt. Closes Session 3. The
dashboard is the trust surface: every action audited, every view showing
provenance.

## What shipped

### Backend endpoints (thin, on existing module interfaces)

Under `/api/memories` (memory module):

- `GET /api/memories` — pagination envelope `{items, total}`, text search via
  `ftsSearch` (`?q=`), filters `scope`, `status`, `sensitive` (with the
  owner-only `includeSensitive` opt-in), `entity` (trigram-matched). Filters
  are WHERE clauses composed with the gates, never post-filters.
- `GET /api/memories/:id` · `GET /api/memories/:id/chain` — detail + the
  supersession chain walked both directions (oldest → newest), every hop gated.
- `GET /api/memories/:id/verification` — the §B.3 verdict + reason + cited
  span, served by ingestion's own slim controller
  (`IngestionModule.forQueries()`), gated through a MemoryStore read; module
  table ownership intact.
- Actions, all audited with the acting principal, all typed-error guarded:
  `POST :id/approve` (uncertain → user_approved; the transition matrix was
  narrowed: **user_approved is reachable only from uncertain** — 21 legal
  transitions now, was 24), `POST :id/mark-outdated`, `POST :id/sensitive`
  (row + Qdrant payload in one two-store transaction, point op last),
  `POST :id/edit` (supersession per 0006 ruling 3: successor `user_approved`
  with the same provenance, predecessor `replaced` + `superseded_by`, embed
  job enqueued via the outbox — the request path never calls the embed model),
  `POST :id/reject` (0006 ruling 4: audited removal of row + point, legal only
  from `uncertain`).
- Source content comes from the existing `GET /api/notes/:id` (connectors) —
  the drawer composes the three module reads client-side; no cross-module
  table access anywhere.

Under `/api/jobs` (entrypoints — queue plumbing is infrastructure):

- `GET /api/jobs/dead-letter` — job type, idempotency key, error, attempts,
  last failure.
- `POST /api/jobs/dead-letter/:id/retry` — re-enqueue + row removal in one
  transaction, audited; the S1-B execution guard (`job_execution` unique key)
  makes double-effects impossible however often a job is retried.

`GET /api/health` gained a `queue` check: depth + dead-letter count (`ok:
false` while anything is parked).

New worker job `memory.embed` (memory module owns the handler): embeds an
edit's successor under idempotency key `('memory', <id>, 'memory.embed')`,
row update in the job transaction, point last. Status transitions and
supersession now also sync the Qdrant payload copy (`status`), keeping §A.4's
payload honest.

Migration `0006_verification_span.sql`: `verification_result.source_span` —
the review queue's side-by-side highlight; pre-S3-B rows are NULL and the UI
falls back to the plain source text.

### Dashboard UI (S2 preview replaced entirely)

- **Memories**: capture card on top; below it the governed list — status
  chips (same color vocabulary as chat, one shared `status.ts`), sensitive
  badge, clickable entity tags (tag → filter), relative timestamps, search
  box + filter bar (status, scope, entity, sensitive-only), pagination.
  Row click → the **detail drawer**: full content, allowed actions for the
  current status, sensitive toggle, verification verdict + reason + cited
  span, provenance panel (source type, source text, captured when), history
  panel rendering the chain oldest → newest with the current version marked,
  and the edit affordance (textarea, "Save as correction", one-line
  supersession explainer on first use via localStorage).
- **Review** (nav enabled, amber count badge fed by the uncertain total):
  fact and source side by side with the cited span highlighted, verifier
  reason, Approve / Reject (confirm dialog; server-side guard is the
  authority).
- **System**: health panel including queue depth, dead-letter table with
  Retry.
- **Chat integration**: citation chips deep-link to `/memories?open=<id>`,
  which opens the drawer. Freshness audit: the server caches nothing per
  request (retrieval queries live; ChatService caches only the immutable
  prompt artifact); the SPA invalidates all react-query caches after every
  action, so new chat answers and chips reflect edits/approvals immediately.
- API errors now surface the server's typed message (e.g. the exact illegal-
  transition reason) as the UI copy.

Build note: `@cogeto/shared` is now bundled from TypeScript source in the
Vite build (alias) — the SPA's first *value* import from the package exposed
that rollup cannot statically resolve the CJS re-exports.

## Tests (all green — 36 passed + 1 live-optional, 12 files)

| Test | Result |
|---|---|
| `edit_supersession` | pass — successor `user_approved`, predecessor `replaced` + `superseded_by` + closed interval; chain identical from both ends; old content untouched; embed job enqueued and, once run, the point exists |
| `review_transitions` | pass — approve only uncertain→user_approved by the owner; reject only from uncertain; both audited; reject removes row AND point (asserted in both stores) |
| `sensitive_toggle_two_store` | pass — simulated Qdrant crash rolls the row back; retry converges; the gate is live in vector search |
| `actions_audited` | pass — exactly one audit row per action with actor `user:<id>`; idempotent no-op toggle writes none |
| `illegal_action_guarded` | pass — approve/reject on active → 400 with the transition reason; edit by non-owner → 404; row untouched |
| All prior suites | pass — one S1 expectation updated to the narrowed matrix (user re-affirms contradicted memories via `active`; approval is the review verdict) |

Full battery: build, lint, boundaries (149 modules, 0 violations),
`docker compose up` → login, 7 containers healthy, migration 0006 applied,
health `ok` including the queue check.

## Eval run (2026-07-03, extraction/v0001 + verification/v0001 — unchanged prompts)

| set | cases | precision | recall | verification agreement |
|---|---|---|---|---|
| en | 8 | 100.0% | 100.0% | 57.1% |
| hr | 8 | 71.4% | 81.8% | 57.1% |
| **aggregate** | **16** | **84.6%** | **90.9%** | **57.1%** |

No prompt or model changes this session; numbers are within run-to-run
variance of the S2-B baseline (82.1% / 90.9% / 64.3%). The verification-
agreement gap remains the known relative-date issue queued for
`verification/v0002`. Appended to `docs/eval/history.md`.

## Owner verification checklist

1. `docker compose up` → login. The nav shows **Review** (with a count badge
   when anything is uncertain) and **System**.
2. Capture a note with a vague claim (e.g. *"I think Marko maybe wants the
   audit in August"*) — it should land in **Review**; check the fact next to
   the highlighted source span, then Approve one and Reject another; watch
   the badge drop and the audit trail grow.
3. Open any memory from the list: check provenance (the original note),
   the verification verdict, and toggle sensitive — then confirm the memory
   disappears from chat answers (hard gate).
4. Edit a memory's content ("Save as correction") — the drawer jumps to the
   approved successor; the history panel shows both versions; ask chat about
   it and see the corrected fact cited.
5. Click a citation chip in chat — it opens this drawer directly.
6. **System**: queue shows 0 dead-lettered; if you ever see one, Retry is one
   click and provably can't double-run completed work.
7. **Use Cogeto with real notes for one full day before Session 4** —
   capture everything you would normally jot down, ask chat about it the next
   morning, correct what it got wrong. Session 4 (reconciliation, deletion
   saga, eval gates) will be shaped by what that day surfaces.
