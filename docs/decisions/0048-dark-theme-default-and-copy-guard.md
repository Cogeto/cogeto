# 0048 — Dark theme as default, and the product-copy dash guard

Date: 2026-07-23. Status: accepted. Context: surface polish (P6.8). Frontend
only, no migration, no new dependency. See `docs/notes/surface-polish.md` and the
dark-theme section of `docs/design/README.md`.

## Context

The SPA shipped a single light theme (O3-C design system, extended by the Post-v1
Priority 2 dashboard, which introduced the dark instrument hero). Two polish items
were due: a proper dark theme, and enforcement of the owner's house style that
Cogeto's own copy carries no em/en dashes (already applied to the README and
website; not yet to the app).

## Decision

### Dark as a first-class, default theme

- **One token set, two themes.** Light values live in `@theme`; the dark theme
  re-derives the neutral ramp, one surface token (`--color-surface`), and the chart
  hues (`--chart-*`) under `:root.dark` in `index.css`. Not a CSS `invert()` filter:
  a hand-tuned dual palette of navy-tinted deep neutrals (no pure black). This works
  because Tailwind v4 compiles color utilities to `var(--color-…)`, so overriding
  those variables under `:root.dark` re-themes every `slate` utility at once.
- **Surface vs on-color white are separated.** `bg-white` (a surface) became
  `bg-surface` and re-points in dark; `text-white` (ink on a colored control) keeps
  its variable and does not move. Accent ramps (amber/red/violet/sky/teal) are NOT
  remapped — that would break `bg-*-600 text-white` buttons; the tinted status/tone
  chips and the few inline alert texts carry explicit `dark:` variants instead.
- **Default + precedence:** dark is the default for new users and anonymous
  surfaces (login, demo login, Ana sandbox). Precedence: explicit user choice >
  stored preference > system hint (`prefers-color-scheme`) > default dark
  (localStorage `cogeto-theme`). A pre-paint inline bootstrap in `index.html`
  applies the theme before React mounts (no flash); `src/theme.ts` mirrors the
  precedence and owns the Settings → Appearance toggle. The class-based `dark`
  variant is authoritative over the media query.
- **Load-bearing colors re-derived for dark** and verified AA against their real
  dark backgrounds (`theme-contrast.spec.ts`, pure WCAG math): the six lifecycle
  statuses plus `sensitive`/`shared`/dormant/past-belief, colorblind-distinguishable,
  with label + icon so meaning is never color-only. Chart hues verified `>= 3:1`.

### Product-copy dash guard

A local ESLint rule `copy/no-typographic-dashes` (inline in `eslint.config.mjs`,
no new dependency), part of the required `lint` check, fails on an em (—) or en (–)
dash in string literals, JSX text, and template literals under `project/web/src`.
It inspects only those AST nodes, so code comments are exempt. Out of scope and
excluded: specs/fixtures, code identifiers/comments, third-party output,
user-entered data (including the seeded demo note bodies, which simulate a user's
own writing and feed demo extraction), historical records, backend log/error
strings, docs authoring notes, and CLI/log output where a dash is syntax.

## Consequences

- Dark is the pitch surface (the Ana sandbox and the deletion receipt read as a
  dark certificate). Contrast is enforced by a test, so a future token change that
  regresses the status palette fails the build.
- The house style is now enforced forever on frontend copy by a required check; the
  rewrite chose punctuation per sentence (comma/colon/period/restructure), never a
  mechanical hyphen.
- No functional or route changes; theme is per browser (localStorage), so no schema
  or endpoint was added.
