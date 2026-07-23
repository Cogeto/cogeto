# Surface polish (P6.8)

Delivered 2026-07-23. Two independent improvements, one PR: **dark mode as the
default theme** (issue #213) and **em/en dash removal from product copy with a
lint guard** (issue #214). No functional or route changes, no new dependencies.
Full context: `docs/design/README.md` (dark theme section), decision 0048.

## A. Dark theme

First-class dual palette, not an inversion filter. Light values in `@theme`; dark
re-derivation under `:root.dark` in `project/web/src/index.css`. Tailwind v4
compiles utilities to `var(--color-…)`, so overriding the palette variables under
`:root.dark` re-themes every `slate` utility at once; the neutral ramp is
re-derived as navy-tinted deep neutrals (no pure black).

- **Default + precedence:** dark is the default (new users, anonymous surfaces:
  login, demo login, Ana sandbox). Precedence: explicit user choice > stored
  preference > system hint (`prefers-color-scheme`) > default dark. localStorage
  key `cogeto-theme`. Pre-paint bootstrap sets `<html class="dark">` before React
  mounts (no flash) via an **external** same-origin file (`public/theme-init.js`,
  a classic blocking `<script src>` before the module) — an inline script is
  blocked by the SPA's strict CSP (`script-src 'self'`; QS-19), which was the
  first bug found after merge (dark applied in-session but not on reload).
  `main.tsx` re-applies the resolved theme on mount as a safety net. `src/theme.ts`
  mirrors the precedence and owns the Settings → Appearance toggle. Class-based
  `dark` variant (`@custom-variant dark`) is authoritative over the media query.

### Hardcoded colors moved to tokens

The sweep removed every per-component hardcoded hex/rgb from components and pages,
moving them to tokens:

- `bg-white` (39 surface uses across 19 files) → `bg-surface` (`--color-surface`),
  so surface re-points in dark while `text-white` (on-color ink) stays put.
- `components/StatsPanel.tsx` chart hex (donut hues, ring track `#e2e8f0`, task-bar
  colors, sparkline colors: `#21c29a`, `#0b6b57`, `#d97706`, `#dc2626`, `#64748b`,
  `#94a3b8`) → theme-aware `--chart-*` tokens (defined in `index.css`, re-derived
  for dark).
- `CountBadge` ink `text-slate-900` (on the fixed amber-400 badge) → `text-brand-navy`
  (theme-independent, since the badge bg is fixed in both themes).
- Scrims `bg-slate-900/25` and `bg-slate-900/30` (would invert to a light scrim) →
  fixed `bg-black/40` / `bg-black/50`.
- Code chip `bg-black/10` → adds `dark:bg-white/10`; timeline rail halo
  `border-white` → `border-surface`; demo banner `bg-white/95` → `bg-surface/95`.

**Deliberate exception (NOT moved):** the `PrintableReceipt` in
`pages/Forgotten.tsx` keeps its inline hex inks (`#0f172a`, `#64748b`, `#1c2150`,
`#334155`, `#f8fafc`, `#e2e8f0`, `#21c29a`). That component is `display:none` on
screen and printed onto a forced-white background (`.receipt-print` print CSS), so
it is a print certificate: its ink must be theme-independent (dark ink on white
paper), never re-themed. The on-screen receipt (the `ReceiptDrawer` body) uses the
normal themed components and renders as a dark certificate.

### Status palette + chart contrast on dark (measured, WCAG 2.1)

Verified programmatically in `project/web/src/theme-contrast.spec.ts` (pure math,
no dependency). Thresholds: text AA `>= 4.5:1`; chart hues (non-text, 1.4.11)
`>= 3:1`. Chips keep label + icon redundancy, so meaning is never color-only, and
each hue pair stays colorblind-distinguishable.

Neutral text (on canvas `#0f1222` / on surface `#171a2e`):

| Token | canvas | surface |
|---|---|---|
| slate-400 (muted) | 6.19:1 | 5.71:1 |
| slate-500 (secondary) | 8.32:1 | 7.68:1 |
| slate-600 | 10.69:1 | 9.87:1 |
| slate-700 | 13.19:1 | 12.18:1 |
| slate-800 (primary) | 15.46:1 | 14.27:1 |

Status/tone chips (ink on the 15% accent tint over surface):

| Chip | ratio |
|---|---|
| active / approved / positive (teal) | 5.84:1 |
| uncertain / warning (amber) | 8.64:1 |
| contradicted / danger (red) | 7.83:1 |
| sensitive / info (violet) | 7.27:1 |
| shared (sky) | 7.82:1 |

`outdated` / `replaced` / neutral / past-belief chips ride the remapped slate ramp
(dark bg, light ink) and inherit the neutral-text ratios above.

Chart hues on the dark surface (all `>= 3:1`): active 9.22, approved 11.60,
uncertain 10.28, contradicted 6.20, outdated 6.69, replaced 11.56.

### Tests

`theme.spec.ts` — precedence (`theme_default_dark`), apply/persist/toggle,
`no_flash` (asserts the pre-paint bootstrap runs before the app bundle).
`theme-contrast.spec.ts` — the ratios above. All 41 web tests green; Lighthouse
accessibility target (95+) maintained on the built SPA in dark (the audited status
palette and neutral text all clear AA with margin).

## B. Dash removal + guard

Removed every em (—) and en (–) dash from user-facing product copy and added a
forever-enforced guard.

- **Guard:** local ESLint rule `copy/no-typographic-dashes` (inline in
  `eslint.config.mjs`, no new dependency), part of the required `lint` check. It
  flags the characters in string literals, JSX text, and template literals under
  `project/web/src`; it inspects only those AST nodes, so **comments are exempt**.
  Demonstrated catching a planted dash, then removed. `index.html` copy is kept
  clean by hand (ESLint does not parse HTML).
- **Exclusions (out of scope):** specs/fixtures; code identifiers and comments;
  third-party output; user-entered data, including the seeded demo note bodies in
  `project/demo/seed/corpus.json` (they simulate Ana's own sloppy writing, feed the
  demo extraction, and are not Cogeto's product voice); historical records (audit
  entries, existing memories); backend log/error strings; docs authoring notes (not
  served to users); CLI/log output where a dash is syntax.

### Rewrites: 88 occurrences across 25 files (+ index.html title & meta)

Chosen per sentence (period for independent clauses, comma for asides, colon for a
defining/list lead-in, middot ` · ` for the "X — fetched TIME" separators), never a
mechanical hyphen. Placeholder glyphs became words (`'—'` → `None` / `Pending` /
`Not yet` / `n/a`).

| Area | count |
|---|---|
| pages/Settings.tsx | 16 |
| components/ResearchInline.tsx | 10 |
| pages/Research.tsx | 9 |
| components/SourceDrawer.tsx | 8 |
| pages/Forgotten.tsx | 7 |
| pages/Chat.tsx | 5 |
| components/MemoryDrawer.tsx | 4 |
| components/DemoIntro.tsx, components/TimelineView.tsx, components/UploadCard.tsx, pages/Timeline.tsx | 3 each |
| components/CitationChip.tsx, pages/System.tsx, pages/Tasks.tsx | 2 each |
| CaptureCard, GovernedMemories, ResearchAnswer, StatsPanel, UnsourcedChip, WorkerActivityPanel, Approvals, Audit, DemoLogin, Memories, Review | 1 each |
| index.html (`<title>`, meta description) | 2 |
