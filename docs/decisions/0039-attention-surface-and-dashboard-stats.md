# 0039 — Attention surface + dashboard statistics (computed feed, honest unread)

**Date:** 2026-07-21 · **Status:** accepted · **Governs:** the in-app "what
needs my attention" surface and the dashboard statistics (Post-v1 Backlog
Priority 2): computed-vs-materialized, where read-state lives, the unread
semantics, per-item dismissal, gating, and the statistics endpoint's cost
bounds. **Driven by:** the Priority-2 owner prompt, §A.1 (module boundaries),
§A.4/§A.5 (gated reads), decision 0020 (shared-scope surface rules), decision
0011/0013 (dreaming digest + tasks). Migration this session is **0026**.

Priority 2 supersedes the earlier Release-A email-notification framing: rather
than depend on outbound mail and its deliverability problems, the dashboard is
the place the user sees what is due, open, gone quiet, awaiting approval, and
what changed overnight. In-app only; no mail is sent; zero new external
dependency.

## Ruling 1 — The feed is COMPUTED, not materialized

The attention feed is a thin derived view assembled per request from signals
the instance already produces: task due-dates and dormancy (tasks engine), the
uncertain and contradicted queues (memory), pending approvals (agents), and the
latest dreaming digest lines (ingestion). No attention-item rows are stored —
duplicating state that already exists would create a second source of truth to
keep honest. Each item is typed (`kind`), human-phrased (`title`), timestamped,
and deep-linked (`href`), with a stable content-free `key`.

## Ruling 2 — The ONLY materialized state is read-state

Two tiny per-user tables (migration 0026), co-located with `audit_log` in
infrastructure because the surface spans every bounded context and none owns it
(§A.1 rule 2):

- `attention_state (owner_id PK, last_seen_at)` — when the user last viewed the
  surface.
- `attention_dismissal (owner_id, item_key, dismissed_at, PK(owner_id,
  item_key))` — per-item dismissal for digest lines only.

Dismissal keys are **content-free by construction** — `digest:<run_id>:<index>`,
never memory text — so this durable row never stores content (the same bar as
the audit trail, decision 0025).

## Ruling 3 — Unread semantics (frozen)

- **"New"** = an item whose `timestamp` (the moment it became relevant — a
  task's due date, when it entered the due-soon window, a review item's newest
  `created_at`, a contradiction's `detected_at`, an approval's `created_at`, the
  digest run's `finished_at`) is **after** `last_seen_at`. All timestamps are in
  the past, so "new" is honest.
- **What clears it:** *viewing the surface*, not clicking every item. Opening
  the dashboard marks seen (`POST /api/attention/seen` sets `last_seen_at =
  now`) and the nav badge drops to zero. The current view keeps its per-item
  "new" highlights so the user can see what changed; the next visit reflects the
  persisted mark.
- **Per-item dismissal** exists ONLY where it makes sense: digest lines (a
  discrete overnight change) are dismissible; a live count ("3 items in review")
  is **not** — it clears when the work is done, not when hidden. The server
  rejects a dismiss whose key is not a `digest:` key.

## Ruling 4 — Gating is absolute, through the existing gated reads

Every item and every number is Principal-scoped through each module's public
interface — never a raw cross-module table read (§A.1). The composition lives in
the `entrypoints` root (with audit/jobs), reaching memory / tasks / agents /
ingestion only through their barrels; each returns already-gated results:

- Review counts use the owner-only (`mine`) read — you review your own uncertain
  facts, never a peer's shared ones (mirrors the Review queue and its badge).
- Task attention is owner-scoped (the caller's workload), like the tasks badge.
- The digest reuses the one gated builder (`buildDreamDigest`): an action on a
  memory the caller cannot read simply produces no line — resolution, not
  post-filtering. A stranger sees nothing.
- Sensitive content never appears in notification text beyond what the owner may
  already see (the digest builder resolves through the owner's gated read with
  `includeSensitive`, i.e. only the owner's own sensitive rows).

Shared-scope visibility follows decision 0020: the "memory by status" governance
count spans own + visible-shared, but the review count stays owner-only.

## Ruling 5 — The statistics endpoint is cheap and bounded

`GET /api/dashboard/stats` returns counts, grouped counts, and two **bounded**
daily series (30 UTC days). No unbounded scan on page load: grouped counts hit
indexed columns; each series carries a `created_at >= now - 30d` (or run-window)
bound; the dreaming series resolves per-action visibility in memory (a bounded,
windowed set), never a cross-module SQL join. Query count is fixed regardless of
store size (a test asserts it stays constant and small under 10× data). Short
client-side caching is fine; nothing here needs nightly precomputation yet — if
a future series does, it will be derived in the dreaming cycle and stored small.

## Ruling 6 — The digest integrates; its contract is preserved

The dreaming digest is no longer a separate dashboard panel — it is the
attention surface's "Last night" group. The `GET /api/dreaming/latest` endpoint
and its `DreamDigestDto` are unchanged; the line-building was extracted into one
shared, gated builder that both the digest endpoint and the attention feed use,
so there is exactly one digest. The standalone `DreamDigest` React component was
removed (its role fully assumed by the surface); its links and contract live on.
