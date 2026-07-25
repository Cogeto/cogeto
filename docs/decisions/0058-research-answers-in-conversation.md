# 0058 — Research answers land in the conversation, automatically

**Date:** 2026-07-25 · **Status:** accepted · **Amends:** 0057 ruling 5 (the
resume/replay surface) and the 0050 in-chat flow's conclusion step (issue
#259; field-reported). Migration this session is **0033**.

Two behaviors proved wrong in use. The inline card's "Add to conversation"
re-asked the topic as a retrieval turn — which answers "nothing on record"
precisely when research fell back to page-grounded synthesis (zero durable
facts): the one case that needed it most. And any answer that lived only in a
dismissible card was effectively lost from the conversation.

## Ruling 1 — Delivery is automatic and persistent

A research run proposed from chat records its `conversation_id` (migration
0033; value reference, no FK — a deleted conversation skips delivery
silently). When the run concludes — worker or interactive, whichever wins the
**guarded** conclusion write (`WHERE status = 'approved'`, so a race can never
deliver twice) — the answer is appended to that conversation as a persistent
ASSISTANT message: `[M#]` markers become canonical `{{cite:<uuid>}}` chips,
`[W#]` markers become numbered references over a Sources block (title, URL,
fetch date; literals follow the 0052 language anchor). No buttons, no "Done",
no user action. Research-page runs (no conversation) keep the stored answer
there, unchanged.

## Ruling 2 — The append crosses modules through a retrieval-owned seam

Retrieval owns the chat tables, so it owns both the port
(`CONVERSATION_APPEND` / `ConversationAppendPort`) and the implementation
(`ConversationScribe`: owner-checked, bumps the conversation's recency,
strips every `{{…}}` token except the canonical cite form). Connectors
injects the token `@Optional` and never touches a chat table (§A.1 rule 2).
The import direction stays connectors → retrieval; no cycle.

## Ruling 3 — The inline card shows progress only; resume shrinks

`ResearchInline` never sends anything on the user's behalf and renders no
answer: search → sources read → extraction progress → "writing the answer
into this conversation" → the thread refreshes with the appended message and
the card closes itself. The chat resume surface now picks up ONLY approved
runs still in flight (progress display); concluded runs never resume — their
answer is in the thread, or on the Research page for conversationless runs.
A delivered answer counts as `answer_seen_at`.

## Named tests

`research_concludes_server_side` (extended: the appended thread message with
numbered references + Sources), `conversationless runs conclude without
appending` (`project/src/connectors/research-conclusion.integration.spec.ts`);
the conversation-id ride-along in `research_intent_gated`
(`project/src/retrieval/chat/chat-research-intent.integration.spec.ts`);
`research_resume` (approved-only)
(`project/web/src/components/research-resume.spec.ts`).
