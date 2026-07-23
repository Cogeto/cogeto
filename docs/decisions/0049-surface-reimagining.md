# 0049 — Surface reimagining: uniform frame and the Ask → Briefing chat

Date: 2026-07-23. Status: accepted. Context: owner feedback after P6.8/P6.9 that
the chat felt dated and pages changed width. Frontend only, no migration, no new
dependency. Delivered across PRs #223 (frame), #225 (chat), and the polish PR.

## Context

The dashboard SPA had a per-page content width (left-aligned, dead gutter on wide
screens), a page-header sign-out that stuck out, and a chat that read like a
generic agent widget (bubbles both sides, an "Ask" button). The owner asked for a
signature experience, not a ChatGPT/Claude clone.

## Process

Because the chat is the product's most-used and most-subjective surface, the
design was **mocked first** as a self-contained Artifact and iterated to approval
before any app code changed — avoiding another blind rewrite. The approved mockup
is the reference for the implementation.

## Decision

### One uniform, fluid frame

- **Width:** every page uses one centered column that fills the screen up to a
  roomy cap (~1280px), then centers (`Shell` `COL`). No per-page tiers.
- **Scrollbars hidden app-wide** (still scrollable) so a centered column never
  shows a mid-screen track. Full-height pages (chat) pin the app to the viewport
  (`h-screen overflow-hidden`) so only their inner pane scrolls.
- **Sidebar:** wider, a cohesive family of **custom Cogeto node-glyphs** (a
  recurring node/orbit "verification" motif), a teal active indicator + tint, and
  the **identity + sign-out pinned to the bottom** (out of the page header). The
  header is a calm mono `Cogeto · <Page>` breadcrumb.

### Chat as "Ask → Briefing"

Provenance is the visual identity, not a chatbot skin:

- The question renders as a confident heading; Cogeto answers as flush editorial
  prose along a teal **evidence rail** (no bubbles — fixes the plain-vs-bubble
  asymmetry).
- Every claim carries a mono **provenance chip** (`◈ kind · date`), state-tinted:
  teal memory / sky web / amber uncertain / red contradicted / muted past.
- Each answer closes with a **"stands on" manifest** — the unique sources it drew
  from — and unmarked model knowledge is honestly marked amber (`◆ unsourced`).
- The composer is a docked **command bar** (Cogeto mark, auto-grow textarea,
  Enter-to-send, up-arrow icon, teal focus-glow); the empty state greets and
  offers starter prompts.

All existing behaviour is preserved: SSE streaming, the citation drawer, the
research minimise-and-approve gate inline, and remember-this.

## Consequences

- The chat is a distinctive, provenance-forward surface only Cogeto can claim.
- The token system and dark/light themes, AA contrast, reduced-motion, and focus
  rings are all honored; no new dependency; every check stays green.
- Supersedes the P6.9 per-page width tiers (decision context in
  docs/notes/surface-polish.md) with a single uniform width.
