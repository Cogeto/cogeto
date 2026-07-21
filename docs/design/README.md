# Cogeto design system (O3-C)

One place for the visual language of the dashboard SPA (`project/web`). The
system is small on purpose: a brand-anchored palette, one type/space/radius
rhythm, and a **single set of canonical components** so the same concept looks
the same everywhere. Tokens live in `project/web/src/index.css` (`@theme`); the
status vocabulary in `project/web/src/components/status.ts`; the component kit in
`project/web/src/components/ui.tsx`.

> The logo is a trademark — never modify, recreate, or restyle it
> (`assets/brand/README.md`, `TRADEMARK.md`). We only *reference* the two brand
> colors; the SVGs are used as-is.

## Palette

| Token | Value | Use |
|---|---|---|
| `brand-navy` | `#1C2150` | headings accents, sign-in, theme-color |
| `brand-navy-deep` | `#141833` | left nav surface (the dark logo blends in) |
| `brand-teal` | `#21C29A` | **bright accent** — primary buttons, focus ring, live dots |
| `brand-teal-ink` | `#0B6B57` | **teal as text** — AA (6.5:1 on white). The bright teal fails AA as text (2.3:1), so text/links/chips use the ink. |
| `brand-teal-surface` | `#E3F6F1` | teal chip background |

Neutrals are Tailwind `slate`; semantic accents are Tailwind `amber` / `red` /
`violet` / `sky`, all chosen at AA-passing text shades.

### Instrument extension (Post-v1 Priority 2 — dashboard)

The redesigned dashboard adds a single **dark instrument surface** for the
attention hero — "mission control for your practice", not neon or gamer. It
stays within the brand: it is the navy nav surface, deepened. Three documented
token extensions, used ONLY here:

| Token | Value | Use |
|---|---|---|
| `brand-navy-900` | `#0E112A` | one step below `navy-deep`; the hero gradient floor. **Surface only, never text.** |
| `--shadow-glow` (`shadow-glow`) | `0 10px 40px -18px rgba(33,194,154,.45)` | the hero's single teal rim-glow — depth, used once, never on list items |
| `--animate-rise` (`animate-rise`) | `rise .26s ease-out both` | entrance settle for the hero; under 300ms, never loops |

On the dark hero the **bright** teal (`brand-teal #21C29A`) is the accent TEXT
color — it is **8.2:1 on `navy-900`**, comfortably AA (the ink teal is for light
surfaces only). Body text on the hero is `white` / `white/90`; secondary is
`white/60`, all AA on the navy gradient. The statistics below the hero stay on
the light `Card` system — depth is meaningful (the hero is the one dark panel),
not decorative.

Charts are hand-rolled SVG (no charting dependency): a status donut, compact
bars, sparklines. Color never carries meaning alone — every chart has a labelled
legend or a text-equivalent `aria-label` (`seriesSummary`), and the status donut
reuses the load-bearing status hues below.

## Status colors (load-bearing — AA + colorblind-safe)

Status carries information, so each of the six lifecycle states has a fixed
color **and** a distinct label + icon. Color is never the sole signal (verified
against WCAG AA and the "no info by color alone" rule).

| Status | Chip (bg / text) | Icon | Contrast |
|---|---|---|---|
| `active` | teal-surface / teal-ink | ● | 5.8:1 |
| `user_approved` ("approved") | teal-surface / teal-ink | ✓ | 5.8:1 |
| `uncertain` | amber-100 / amber-800 | ? | 6.4:1 |
| `contradicted` | red-100 / red-700 | ⚠ | 5.3:1 |
| `outdated` | slate-100 / slate-600 | ○ | 6.9:1 |
| `replaced` | slate-100 / slate-600 | ↻ | 6.9:1 |
| `sensitive` (flag) | violet-100 / violet-700 | 🔒 | 6.0:1 |

`active`/`approved` share a hue but differ by icon+label; likewise
`outdated`/`replaced` — so red-green colorblindness never loses meaning.
Adjacent, non-status chips (health up/down, file state, verification verdict,
worker stats, approval status) use the shared `Tone` vocabulary
(`positive`/`warning`/`danger`/`neutral`/`info`) so the whole app reads as one
system.

## Typography, spacing, radius, elevation

- **Font**: a system sans stack (`--font-sans`) — no web font to load. Mono for
  ids/hashes.
- **Scale**: hierarchy is carried by weight + case more than size — `text-sm`
  body, `text-xs` uppercase-tracked section headings (`<SectionTitle>`), `text-lg`
  page title (the Shell's single `<h1>`), `text-base` for a memory's own content
  in the drawer.
- **Spacing**: cards `p-4`, drawers `p-6`, content column `gap-6`; chips
  `px-2 py-0.5`.
- **Radius**: `rounded-md` controls, `rounded-lg` cards/panels, `rounded-full`
  chips.
- **Elevation**: `shadow-sm` for cards, `shadow-xl` for the drawer. Flat
  otherwise — depth is meaningful, not decorative.

## Motion

Subtle and **always reduced-motion-aware** (a global
`@media (prefers-reduced-motion: reduce)` freezes every animation/transition):
`transition-colors` on interactive elements, a 160 ms drawer slide-in
(`animate-drawer-in`), a 260 ms dashboard-hero entrance (`animate-rise`), the
skeleton shimmer, the worker indeterminate bar, and the "working" pulse dots.
Rule: motion is **entrance / transition / feedback only**, under ~300 ms, and
nothing blinks or loops forever (the pulse dots are the one bounded exception,
and they too freeze under reduced-motion).

## Component kit (`components/ui.tsx`)

Use these instead of hand-rolling — they are the anti-drift layer:

- **Chips/badges**: `StatusChip`, `Pill` (tone), `VerdictChip`, `SensitiveBadge`,
  `SharedBadge`, `PrivateTag`, `DormantBadge`, `EntityChip`, `CountBadge`.
- **Buttons**: `btnPrimary` / `btnSecondary` / `btnDanger` (class constants).
- **Layout**: `Card`, `SectionTitle`, `Tabs`.
- **States**: `EmptyState` (teaching; `tone="positive"` for accomplishment
  zero-states), `ErrorState` (never blames, offers a retry), `Skeleton` /
  `SkeletonRows` (loading with shape).
- **`Drawer`**: the one overlay — `role="dialog"`, `aria-modal`, Escape (top-most
  only, so nested drawers behave), focus-in-then-restore, slide-in.

## Accessibility rules (enforced in this pass)

- One visible focus ring on every keyboard-focused control (global
  `:focus-visible`); inputs no longer strip their outline.
- No information by color alone — chips carry a label (+ icon); count badges and
  liveness dots carry `aria-label` / `sr-only` text.
- Semantic headings (`h1` in Shell → `h2` section → `h3` panel), landmarks
  (`nav[aria-label]`, dialog), `aria-current` on the active nav item.
- Loading and streaming announce politely (`role="status"` / `aria-live`).
- Target AA contrast throughout; the status palette is the audited case above.
