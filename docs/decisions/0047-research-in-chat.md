# 0047 — The research gate, inline in chat

Date: 2026-07-23. Status: accepted. Context: owner UX request after Priority 6
(decision 0046); revises the UI framing of decision 0045 ruling 4. No
migration.

## Context

Decision 0045 froze the research honesty mechanism — a `research_run` record
whose approval is a server-side, owner-only, audit-logged transition, with
discovery impossible without it — and framed its UI as the Research page:
chat could only propose and then point the user away. In practice that page
hop broke the conversation: approve, pick, fetch, synthesise, and read all
happened outside the surface the user was talking in.

## Ruling 1 — The gate is a component, not a page

The show-edit-approve gate becomes embeddable in the chat surface. A chat
research turn (or tapping the research offer) opens the SAME gate as an
inline card: the minimised query shown and editable, the one-line reason,
"Approve & search" / "Cancel — send nothing". **The mechanism does not
move**: the chat page calls the same owner-gated `/api/research/runs/*`
endpoints the Research page calls; approval remains the server-side
`research_run` transition (0045 rulings 1–3 untouched — `sent_query`
immutable, cancel terminal, transitions audit-logged); and the backend chat
turn still only PROPOSES — its done event now carries the run id
(`researchProposal`) so the surface can open the gate, nothing more. The
Research page remains the durable home: past runs, resume, and the
page-grounded synthesis.

## Ruling 2 — Progress is honest, not silent

After inline approval, the discovered pages render as an inline picker (the
sent query disclosed exactly as on the Research page), fetch reports per-URL
outcomes, and a new owner-gated read — `GET /api/research/runs/:id/progress`
— surfaces each captured page's pipeline state (the queue-ledger derivation,
the notes rule) plus its derived-fact count, so the extraction wait shows as
"extracting and verifying facts from N pages…" instead of a spinner over
nothing. Read-only; counts come through the memory module's public interface
(the FilesService precedent).

## Ruling 3 — The conversation concludes in the conversation

When extraction settles with facts, chat concludes by ASKING: the research
topic is sent as a normal, visible chat turn and the answer streams grounded
in the fresh web memories — a persisted chat message in the canonical
citation grammar, whose web-sourced chips carry URL + fetch time, covered by
the strict-grammar guarantee and the existing deletion cascade (erasing a web
source redacts the answers citing its memories, as any source erasure does).
This is deliberately NOT a second answer format: the chat record stays one
grammar, one cascade. The concluding turn suppresses the research offer (no
circular offers). When the pages yield no structured facts, the inline flow
falls back honestly to the page-grounded synthesis (the 0045 endpoint,
unchanged) rendered in place, labeled as such — a useful answer is never
sacrificed to purity, and the fallback still cites per claim ([W#]/[M#]).

## Consequences

- The user can confirm, watch, and read a research end to end without
  leaving chat; nothing about what leaves the instance, when, or on whose
  approval has changed.
- A reload mid-flow loses only the inline card — the run itself persists,
  and the Research page's resume (auto-opening the latest proposed run)
  remains the recovery path.

## Verification

`research_run_progress` (research-flow integration: processing→done with
fact counts, owner-gated), the `researchProposal` handle assertion
(chat-research-intent integration), and the unchanged Part B suite
(`no_query_without_approval`, `edited_query_used`,
`sent_query_in_provenance`, `research_answer_cited`) — the gate's server
semantics are byte-identical.
