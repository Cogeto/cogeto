# Multiple conversations (P6.9)

Delivered 2026-07-24 (issues #248/#249/#250, decision 0056, migration 0031,
prompt conversation_title/v0001). Chat gained conversation containers: separate
threads for separate work, with a sidebar to create, switch, rename, archive
and delete them, deletion running through the §A.7 saga with an honest receipt.

**The sentence that governs everything: memory is the continuity,
conversations are workspaces.** What Cogeto learns in one conversation is
available in every other, because knowledge lives in memory, not in the
thread. Raw turn context never crosses threads.

## The model (decision 0056)

- `conversation` (retrieval-owned, migration 0031): `owner_id`, nullable
  `title`, `title_set_by_user`, `archived`, `created_at`, `updated_at` = the
  last-message time (the sidebar's recency order). `chat_message` carries
  `conversation_id` NOT NULL; the migration adopted all pre-0031 history into
  one "Earlier conversation" container per user, so chat provenance keeps
  resolving.
- Scoping: `recentTurns`, `messageContext` and the ask path read turns from
  ONE conversation. Cross-thread knowledge flows through retrieval only.
- Gating: owner-only everywhere; NotFound for foreign threads, checked before
  SSE headers flush. Org-shared conversations are a stated non-goal for v1.
  Active conversations cap at 100 per user.
- Auto-title: enqueued once after the first exchange
  (`conversation.title` worker job, pipeline tier,
  `conversation_title/v0001`); a manual rename always wins via the guarded
  UPDATE. Untitled threads read "New conversation".
- Deletion: `DELETE /api/sources/chat_conversation/:id` — the saga, extended
  by enumeration only (`SourceCascade.chatSubSourceIds`,
  `counts_json.chat_messages_removed`); the confirm dialog uses the preview's
  real numbers (messages, memories, user-approved, derived tasks) and names
  archive as the safe alternative. Forgotten shows the receipt like any other
  source.

## Where things live

| Piece | Path |
|---|---|
| Tables (conversation + chat_message) | `project/src/retrieval/persistence/tables.ts`, `project/src/migrations/0031_conversations.sql` |
| Service (lifecycle, scoping, ask) | `project/src/retrieval/chat/chat.service.ts` |
| Controller (conversation routes, SSE) | `project/src/retrieval/chat/chat.controller.ts` |
| Auto-titler + job type + prompt ref | `project/src/retrieval/chat/conversation-titler.ts`, `project/prompts/conversation_title/` |
| Deletion adapter | `project/src/retrieval/chat/conversation.source-deletion.ts` |
| Saga extension (cascade, counts, preview) | `project/src/memory/deletion-saga.ts`, `project/src/tasks/tasks-cascade.ts` |
| Sidebar + model | `project/web/src/components/ConversationSidebar.tsx`, `conversations-model.ts` |
| Chat page wiring (deep links, switch, narrow picker) | `project/web/src/pages/Chat.tsx` |
| Drawer framing + Forgotten rendering | `project/web/src/components/SourceDrawer.tsx`, `project/web/src/pages/Forgotten.tsx` |
| Demo conversations | `project/demo/seed/corpus.json` (`conversation` field), `project/src/entrypoints/demo/` |
| Tests | `chat-conversations.integration.spec.ts`, `conversation-titler.integration.spec.ts`, `conversation-deletion-cascade.integration.spec.ts`, `conversations-sidebar.spec.tsx` |

## Deep links

`/chat?c=<conversationId>&m=<messageId>` opens the conversation scrolled to
the message (highlighted briefly). The source drawer's chat context frames the
turns with the conversation title and links there; `?q=` prefill still works.

## Follow-ups noted, not forced

- Attention items do not yet point into conversations (the `/chat` route
  prefix is allowlisted for when they do).
- Message pagination is limit/offset with offset 0 = the latest window; the
  UI loads one window (200) and does not yet page back further.
