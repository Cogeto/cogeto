# 0021 — Chat capture policy (O2-C)

**Status:** Accepted (frozen before implementation). **Context:** the `chat`
`source_type` has existed as a provenance target since S3 but had no writer
(gap audit 3.10). O2-C gives it one. The glossary is explicit — *"the user told
me directly" is provenance too* (`user_note | chat`) — so a statement a user
makes in chat is a legitimate source for memory. The risk is trust: silently
mining someone's conversation into durable, retrievable facts is exactly the
creepiness Cogeto exists to refuse. This record fixes the policy so the
implementation cannot drift toward silent capture.

## Rulings

1. **No silent capture by default.** Asking a question never creates a memory.
   The chat fast path stays retrieval + answer only (§A.3) — no enqueue on
   `ask`. This is unchanged.

2. **Capture is an explicit affordance.** A **"remember this"** action on a
   **user** chat message routes that message through the *normal* pipeline
   (extract → verify → embed → store → reconcile), producing one or more
   memories with `source_type = 'chat'`, `source_id = chat_message.id`.
   Provenance is NOT NULL, always (§A.6) — identical to notes. The captured
   memory's source drawer renders the chat context (the message plus a couple of
   surrounding turns, clearly framed) instead of a note body.

3. **Span selection is deferred, not faked.** v1 captures the whole user
   message. A "remember just this span" refinement is a later addition; **no dead
   UI** ships for it now.

4. **Assistant messages are never captured.** The system's own generated output
   is not evidence about the world. The capture endpoint rejects any message
   whose role is not `user`, and the chat source reader loads only `user`
   messages (defense in depth) — an assistant message can never become a memory.

5. **The auto-capture Settings toggle is DEFERRED.** The roadmap's optional
   *"automatically remember facts I state in chat"* toggle is **not shipped in
   O2-C** — explicit capture is the trust-preserving default, and background
   mining deserves its own deliberate design. **No dead UI** is added. When it
   ships, its derived memories MUST enter as `uncertain` (unless independently
   verified) and surface in the Review queue for the user to confirm — the same
   contract unverified extractions already follow (§B.3).

6. **Scope of chat-captured memories = private by default.** A chat statement is
   the user's own; the derived memory defaults to `private` (the source reader
   omits scope → the embed-store stage defaults private). The user can promote it
   with the O2-B change-scope action. No scope selector is added to chat capture
   in v1.

7. **Deleting the source runs the standard saga.** There is no standalone
   chat-history deletion UI today. But a chat-derived memory's **source deletion**
   (the source drawer's Danger Zone) runs the standard deletion saga (§A.7):
   `ChatSourceDeletion` removes the `chat_message` row inside the enumeration
   transaction, the derived memories and their vectors are erased, and a signed
   receipt is issued — exactly like a note. **If** a general "delete this
   conversation" path is added later, it MUST route through the same saga; no
   direct `chat_message` deletes outside it.

## Consequences

- New writer for `source_type = 'chat'` closes gap-audit 3.10 and 2.6 (the enum
  value gains a writer). Reconciliation, temporal retrieval, task derivation,
  deletion, and receipts are all source-type-agnostic and treat a chat-sourced
  memory identically — verified by tests, including a commitment stated in chat
  deriving a task exactly like one written in a note.
- The capture endpoint is a transactional enqueue via the outbox (§A.3), keyed
  `(chat, message_id, ingestion_pipeline)`, so double-clicks and retries are
  idempotent — a message is captured at most once.
