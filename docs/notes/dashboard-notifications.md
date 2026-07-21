# Dashboard notifications + redesign (Post-v1 Priority 2)

Working notes for the in-app attention surface and the redesigned dashboard.
The binding rulings are in [decision 0039](../decisions/0039-attention-surface-and-dashboard-stats.md);
this records the decisions of consequence and the shapes, for the next session.

## Computed feed vs materialized rows — decided: computed

The feed (`GET /api/attention`) is assembled per request from signals that
already exist (tasks, the review queues, approvals, the dreaming digest). We do
**not** materialize attention-item rows: that would be a second source of truth
to keep honest, and every signal already has its own home. The only materialized
state is read-state — `attention_state.last_seen_at` and
`attention_dismissal(owner_id, item_key)` — two tiny, content-free per-user
tables in infrastructure (migration 0026), next to `audit_log`, because the
surface spans every bounded context and none owns it (§A.1 rule 2).

The composition (`entrypoints/attention.service.ts`) reaches memory / tasks /
agents / ingestion only through their public interfaces, so every count and
every line comes back already gated. New public methods added for it:

- `MemoryStore.statusCountsForPrincipal`, `sourceDailyCountsForPrincipal`,
  `oldestUncertainAtForPrincipal` (all gated).
- `TasksEngine.attentionTasksForPrincipal`, `statusCountsForPrincipal`
  (owner-scoped).
- `ingestion`: `buildDreamDigest` (the one shared, gated digest builder — the
  digest endpoint now delegates to it) + `dreamingActivityForPrincipal`.

## Unread semantics — frozen (decision 0039 ruling 3)

- **New** = item `timestamp` (its became-relevant moment, always in the past) is
  after `last_seen_at`.
- **Clears on viewing** the surface, not on clicking each item. Opening the
  dashboard marks seen and drops the nav dot to zero; the current view keeps its
  per-item "new" marks so you can see what changed.
- **Per-item dismissal for digest lines only.** A live count ("3 items in
  review") is never dismissible — it clears when the work is done. The dismiss
  key is content-free (`digest:<run_id>:<index>`).

## Statistics endpoint — cheap and bounded (ruling 5)

`GET /api/dashboard/stats`: memory-by-status (grouped count), task load
(grouped count), a 30-day distinct-sources series, a 30-day dreaming-activity
series (merges vs conflicts), the two review counts, oldest unresolved review
item, and pending approvals. Every series is windowed (`created_at >= now-30d`);
query count is fixed regardless of store size (asserted in `stats_cheap`). No
nightly precomputation needed yet.

## Chart approach — decided: hand-rolled SVG, no new dependency

The frontend takes on **no new charting dependency** (a standing rule). The
charts are tiny — a status donut, compact task bars, two sparklines — so the
geometry is pure functions in `web/src/components/charts.ts`
(`donutArcs`, `sparklinePoints`, `barHeights`, `niceMax`, `seriesSummary`),
unit-tested in `charts.spec.ts`, and the `.tsx` layer only maps their output to
SVG. Every chart carries a **text equivalent** (`seriesSummary`, an
`aria-label`, or a legend with numbers) and never encodes meaning by color
alone: the donut has a labelled legend, the sparklines have summaries.

## Frontend testing note (no new dependency)

The web workspace has no DOM test harness (no testing-library, no jsdom, no
axe), and adding one needs owner sign-off. So the named Issue-B tests are
covered as **pure-function** Vitest specs instead of render tests:
`attention-model.spec.ts` (grouping, the four render states via `surfaceState`,
the deep-link route allowlist, and that every kind carries a non-color glyph +
label) and `charts.spec.ts` (honest axes, bounded geometry, text equivalents).
a11y is enforced by construction — semantic headings, `aria-live` for the unread
indicator, `aria-label`/`role="img"` on charts, visible focus, AA-checked
accents (the bright teal is 8.2:1 on the navy-900 hero) — and remains a manual
Lighthouse target (95+). If a render/axe harness is wanted later, it is a
one-line dependency ask.

## Design direction

A dark instrument hero (navy gradient, one sparing teal rim-glow) for the
attention surface; the statistics stay on the light card system. Token
extensions (`--color-brand-navy-900`, `--animate-rise`, `--shadow-glow`) are
documented in [docs/design/README.md](../design/README.md). Motion is
entrance-only, under 300ms, and frozen by the global `prefers-reduced-motion`
rule.
