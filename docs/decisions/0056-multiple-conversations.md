# 0056 — Multiple conversations: workspaces over one memory

**Date:** 2026-07-24 · **Status:** accepted · **Governs:** the conversation
model (table, scoping, gating, lifecycle), the auto-title job, and conversation
deletion through the saga (P6.9; issues #248/#249/#250). **Driven by:**
decision 0021 (chat capture; ruling 7 anticipated "delete this conversation
MUST route through the same saga"), 0046 (conversational routing and the
bounded history window), 0054 (chat derives tasks), and the P6.9 owner prompt.
Migration this session is **0031**; prompt family **conversation_title/v0001**.

Chat was one continuous stream. This record introduces conversation
containers — separate threads for separate work (client A prep, client B
contract, quick questions) with a sidebar to create, switch, rename, archive
and delete them.

**The architectural sentence: memory is the continuity, conversations are
workspaces.** The rewriter, router, and answer assembly consume recent turns
from the CURRENT conversation only (the bounded window rule stands, now per
conversation); cross-conversation continuity happens through memory retrieval
exactly as designed, never by leaking another thread's raw turns into context.
What Cogeto learned in one conversation is available in every other, because
knowledge lives in memory, not in the thread.

## Ruling 1 — The model

A `conversation` table owned by the retrieval module's chat area (like
`chat_message`): `id`, `owner_id` NOT NULL, `title` (NULL until titled),
`title_set_by_user` (default false), `archived` (default false), `created_at`,
`updated_at` — where **`updated_at` IS the last-message time**, the sidebar's
recency order. Every `chat_message` gains `conversation_id` NOT NULL (FK,
restrictive: only the saga's adapter deletes a conversation, messages first).
Migration 0031 assigns all existing messages to one **"Earlier conversation"**
container per user, so history is preserved and every chat-derived memory's
§A.6 provenance keeps resolving — no orphan messages, no broken citations.

## Ruling 2 — Ownership and gating

Conversations are per-user and owner-gated everywhere: every conversation
query carries the owner WHERE clause; a foreign or absent conversation is
NotFound (existence must not leak, the saga's own convention), asserted
BEFORE SSE headers flush. Shared-scope memories remain shared through
retrieval as always. **Org-shared conversations are an explicit non-goal for
v1.** Active (non-archived) conversations are capped at **100 per user**
(create refuses with a plain message; archive is unlimited) so the sidebar
stays renderable.

## Ruling 3 — Streams and concurrency

The send/stream endpoint requires `conversation_id`; the message row is
inserted with it before routing, so **a message always lands in the
conversation it was sent to**, however the client behaves afterwards.
Switching conversations mid-stream detaches the client (fetch abort); the
existing QS-14 idle/duration aborts still bound the server side. A detached
stream contaminates nothing: the next thread's context assembly reads its own
turns only (`stream_switch_clean`).

## Ruling 4 — Auto-title, conservatively

After a conversation's FIRST exchange (and only then — one indexed count
guards the fast path), the app enqueues `conversation.title` transactionally;
the worker makes ONE pipeline-tier call (`conversation_title/v0001`: 2 to 6
plain words, the conversation's language, subject not act, no invention) and
commits under a guarded UPDATE (`title IS NULL AND NOT title_set_by_user`).
**A manual rename wins forever** — it sets `title_set_by_user`, and the
guarded UPDATE makes even a mid-flight title job lose. A failed title attempt
retries with backoff and, exhausted, parks in dead_letter with the thread
simply staying "New conversation". This is the ONE sanctioned enqueue on the
chat fast path — never ingestion work (the `chat_fast_path` test pins both
halves).

## Ruling 5 — Deletion through the saga, by enumeration only

`chat_conversation` joins the `source_type` enum (no memory row ever carries
it — memories keep citing their message via `chat`). Deleting a conversation
is `DELETE /api/sources/chat_conversation/:id` — the §A.7 saga, extended by
enumeration only: `SourceCascade` gains the additive `chatSubSourceIds` (the
thread's message ids), whose chat-derived memories the saga locks, enumerates
and deletes in the SAME transaction and the SAME receipt as ever (vectors via
the worker leg; derived tasks via the existing `tasks` cascade; pending
per-message captures cancelled first per QS-5). `counts_json` gains the
additive optional `chat_messages_removed`. The receipt is honest: N messages,
M memories, their vectors, their tasks — and Forgotten renders it like any
other source. The preview (`DeletionPreview`) gains `messageCount`,
`userApprovedCount` and `taskCount` (a read-only `countForMemories` twin on
the tasks cascade) so the confirm dialog states exactly what goes, calls out
user-approved memories and derived tasks, and names **archive as the safe
alternative**. Archiving changes one boolean: everything is kept and stays
retrievable through memory.

## Ruling 6 — Provenance framing

Nothing about the memory schema changes. The source drawer's chat context now
resolves the conversation THROUGH the message: it frames the turns with
"From your conversation: <title>" and deep-links to
`/chat?c=<conversation>&m=<message>`, which opens the right thread scrolled to
the highlighted message. Context turns around a remembered message come from
that message's conversation only.

## Named tests

`messages_scoped`, `memory_continuity`, `migration_preserves`,
`conversations_gated`, `stream_switch_clean`, `archive_preserves`,
`conversation_lifecycle`
(`project/src/retrieval/chat/chat-conversations.integration.spec.ts`);
`autotitle_conservative`
(`project/src/retrieval/chat/conversation-titler.integration.spec.ts`);
`conversation_deletion_cascade`, `delete_confirm_counts`
(`project/src/memory/conversation-deletion-cascade.integration.spec.ts`);
`sidebar_lifecycle`, `deep_links_open_conversation`, `delete_confirm_counts`,
`sidebar_a11y` (`project/web/src/components/conversations-sidebar.spec.tsx`);
the extended `chat_fast_path` (`project/src/retrieval/chat.integration.spec.ts`).
The chat eval harness runs every case inside one conversation container.
