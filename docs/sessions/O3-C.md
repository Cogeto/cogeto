# Session O3-C — The frontend design pass

**Model:** Opus 4.8. **Implements:** a design pass over the dashboard SPA
(`project/web`) — a coherent visual system, canonical components, deliberate
states, and accessibility — **without** route changes, state refactors, or new
dependencies. **No decision record, no migration.** Completes O3; Cogeto is
demoable.

## 1. The system (`docs/design/README.md`)

One home for the language. Tokens in `index.css` (`@theme`); status vocabulary
in `components/status.ts`; the component kit in `components/ui.tsx`.

- **Palette** — brand navy + teal (assets untouched), plus a critical addition:
  **`brand-teal-ink` (#0B6B57)** for teal *as text*. The bright brand teal fails
  AA as text (2.3:1); the ink is 6.5:1. All teal text/links/chips now use it.
- **Status colors are load-bearing** — each of the six lifecycle states has a
  fixed AA color (verified 5.3–6.9:1) **and** a distinct label + icon, so nothing
  is conveyed by color alone and red-green colorblindness never loses meaning
  (`active`/`approved` and `outdated`/`replaced` differ by icon+label, not hue).
  `sensitive` is a distinct violet flag. Adjacent chips (health, file-state,
  verdict, worker, approvals) share one `Tone` vocabulary.
- **Type/space/radius/elevation/motion** — a system sans stack; hierarchy by
  weight + case; `p-4` cards / `p-6` drawers; `rounded-md/-lg/-full`; `shadow-sm`
  cards / `shadow-xl` drawer; subtle motion, all frozen under
  `prefers-reduced-motion` (global).

## 2. Canonical components kill the drift

The audit found the same concept styled 3+ ways (status chip wrappers, sensitive
/ shared / entity badges copy-pasted, four independent teal/red "verified"
badges, two tab idioms, solid-vs-outline destructive buttons, three empty-state
treatments, bare-vs-boxed errors, three hand-rolled drawer overlays). Replaced
with one kit (`components/ui.tsx`), used everywhere:

- `StatusChip`, `Pill` (tone), `VerdictChip`, `SensitiveBadge`, `SharedBadge`,
  `PrivateTag`, `DormantBadge`, `EntityChip`, `CountBadge`.
- `btnPrimary` / `btnSecondary` / `btnDanger`; `Card`, `SectionTitle`, `Tabs`.
- `EmptyState`, `ErrorState`, `Skeleton` / `SkeletonRows`.
- **`Drawer`** — the single overlay (dialog semantics, Escape on the top-most
  drawer only, focus-in-then-restore, slide-in). MemoryDrawer, SourceDrawer, and
  the Forgotten receipt drawer all use it now.

## 3. Screen by screen (judgment, not uniformity)

- **Chat** — streaming answer announced politely (`aria-live`), a typing-dots
  wait state, citation chips inherit the AA status vocabulary, past-belief stays
  muted.
- **Memories** — scannable rows whose content is a real button (keyboard-openable),
  canonical status/sensitive/shared/entity chips; the **drawer reads as a
  dossier**: content → chips → verdict (`VerdictChip`) → provenance → a history
  timeline.
- **Review** — the **contradicted pair is the centerpiece**: a "⚠ These two facts
  disagree" header, the newer side accented teal and the earlier slate, a central
  **vs** divider — the disagreement is legible at a glance. Zero queues render as
  an *accomplishment* (`tone="positive"`), not a void.
- **Tasks** — **blocked vs open is instant**: a left-border accent (amber blocked
  / teal open / muted settled) + a "blocked" pill; the condition reads as a
  sentence ("**Waiting** after Marko confirms the budget.").
- **Forgotten** — the receipt is a certificate: the drawer, a `ReceiptStatus`
  pill, prominent **Export JSON** + **Save as PDF**, the hash chain present but
  quiet; empty state teaches what a receipt is.
- **Audit** — a calm, dense timeline. **System / Settings** — plain and honest,
  no chrome, health as tone pills. **DreamDigest** — quiet, gently accented, now
  **dismissible** (until the next consolidation).

## 4. States + accessibility

- Every list/panel has a deliberate **loading (skeletons, not spinners), empty
  (teaching), and error (never blames, offers a retry)** state. Empty states
  explain what a memory / receipt / task is.
- **A11y**: one visible `:focus-visible` ring everywhere (inputs no longer strip
  their outline); no info by color alone (labels + icons; `aria-label` on count
  badges and liveness dots); semantic headings (Shell `h1` → section `h2` →
  panel `h3`); `nav[aria-label]` + `aria-current`; dialog semantics on drawers;
  polite live regions for loading + streaming; favicon/`apple-touch-icon`/
  `theme-color`/description wired from the brand mark.

## 5. Verify

- **Full build, lint, dependency-boundaries: green** (282 modules).
- **No functional regression** — the full backend suite is green. One failure the
  full run surfaced was **fixed**: the O3-B extraction provenance guard correctly
  drops facts carrying pipeline metadata labels, and the chat-capture test's
  *scripted* extractor naively echoed the whole labeled input (headers included)
  as the claim; the test double now extracts from `SOURCE CONTENT` like a real
  model, so the guard is exercised faithfully. (This was an incomplete-full-run
  gap from O3-B, caught here.)
- **Lighthouse accessibility: 100 / 100** on the built SPA's entry (no failing
  audits). The authenticated screens can't be Lighthouse-audited without the
  backend + a session, but they share the same components, tokens, focus, ARIA,
  and AA palette — see the owner checklist to run it against a live instance.

## Screen-by-screen owner checklist

- [ ] **Chat** — ask a question; the streaming answer reads smoothly and citation
      chips invite a click into the drawer; past facts show muted.
- [ ] **Memories** — rows scan cleanly; open the drawer and confirm it reads like
      a dossier (content, verdict, provenance, history); keyboard-tab to a row and
      press Enter.
- [ ] **Review** — the contradicted pair is unmistakable (newer/earlier accents +
      **vs**); an empty queue feels like a win.
- [ ] **Tasks** — a blocked task is instantly distinct from an open one; the
      condition reads as a sentence.
- [ ] **Forgotten** — delete Ana's contract; the receipt certificate renders, the
      chain badge is calm, **Save as PDF** + **Export JSON** are prominent.
- [ ] **System / Audit / Settings** — plain and legible; health/chain pills read
      as one system.
- [ ] **Keyboard + reduced-motion** — tab through a page (visible focus ring
      everywhere); toggle OS "reduce motion" and confirm animations freeze.
- [ ] **Lighthouse on a live instance** — run against an authenticated screen
      (`docker compose --profile demo up`, then Lighthouse the dashboard) and
      confirm ≥95.

## Screenshots worth capturing for the pitch

1. **The deletion receipt** (Forgotten drawer + the printable PDF certificate) —
   the money shot.
2. **The memory dossier drawer** — content, verdict chip, provenance, history
   timeline.
3. **The contradicted pair** in Review — newer vs earlier, side by side.
4. **Tasks** — a blocked task beside open ones, condition as a sentence.
5. **The dashboard** — DreamDigest "While you were away" + system status.

## Accessibility results

Lighthouse accessibility **100/100** (built SPA entry, no failing audits after
fixing the loading landmark + contrast). AA contrast verified numerically for the
full status palette (5.3–6.9:1); reduced-motion honored globally; keyboard focus
ring on every control; no color-only status encoding.

## What O3-C deliberately did NOT do

- No route, data-hook, or state-management changes; no new dependencies (Tailwind
  v4 + inline SVG/glyphs only).
- No logo changes (trademark — referenced colors only).
- Did not re-audit authenticated-screen Lighthouse scores in-session (needs the
  running stack + a session — owner checklist).
