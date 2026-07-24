# 0050 — Frictionless web research: the tap is the consent, best sources auto-read

Date: 2026-07-24. Status: accepted. Context: owner UX decision — the
show-edit-approve gate plus manual page-picking (decisions 0044/0045/0047) added
too much friction for the single operator. Owner-authorized deviation from the
research gate. Frontend + one discovery field; no migration (the preference is
per-device localStorage, like the theme).

## Context

Web research required, in chat: tap "Research this on the web" → **edit/approve
the minimised query** (a pre-send gate) → **pick which result pages to read**
(checkboxes, nothing pre-selected) → fetch → answer. Two decision points beyond
the initial tap. The owner found the picking especially high-friction and asked:
use a relevance score, don't make me choose, and let me opt out of even the tap.

## Decision

In the **chat** research flow:

- **The "Research this on the web" tap IS the approval.** The query is still
  minimised, but it is sent immediately — no pre-send edit/preview gate.
- **No page-picking.** Cogeto auto-selects and reads the **top 3 sources by
  SearXNG relevance score** (`selectTopByScore`, capped `TOP_K`). SearXNG already
  returns a per-result `score`; discovery now keeps it instead of discarding it.
- **Optional always-on** (`cogeto-auto-research`, localStorage, **off by
  default**): when enabled, a knowledge answer that would offer research just runs
  it — no tap. Toggled in Settings → Web research and via a "Always do this
  automatically" affordance on the offer. Disable-able anytime.

**What is preserved (the honesty mechanism is unchanged):**

- Query **minimisation** still runs on every research.
- The **exact query that left** and the **sources read** are disclosed in-flow
  ("Web searched … · reading the top 3 by relevance") and recorded in every
  derived memory's provenance (`research_run.sent_query`), exactly as before.
- The server-side owner-gated `research_run` approve transition still happens
  (auto-triggered) — the audit trail and per-memory provenance are intact.
- The **standalone Research page keeps the full edit/approve gate and manual page
  selection** as the advanced/control surface.

## Consequences

- The privacy claim shifts from *"approve the query before it leaves"* to *"you
  invoke it (or opt into auto); Cogeto minimises the query, and shows and records
  exactly what left and what it read."* Minimisation + full disclosure + provenance
  remain; only the pre-send preview is dropped, on the owner's authority.
- Economics: same model tiers (discovery is model-free; the score is free).
  Always-on increases web calls — opt-in, and still bounded by the existing
  per-research/per-day budgets.
- Supersedes the **UI framing** of decisions 0044/0045 (gate) and 0047 (inline
  gate) for the chat surface. The underlying mechanisms — `research_run`, the
  minimise prompt, per-claim provenance, the eval cases that judge the sent query
  — are unchanged, so the research eval stays green.
