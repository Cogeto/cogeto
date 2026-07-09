# Session O2-C — Chat-derived memories, seam coverage, corpus growth

**Model:** Opus 4.8. **Implements:** the chat-capture gap (audit 3.10 / 2.6 — the
`chat` `source_type` had no writer) + the untested-seam gap (audit: identity and
model-gateway had no dedicated specs). **Decision:** `0021` (chat capture
policy — frozen before implementation). **No migration** (`chat` already existed
in the `source_type` enum; `chat_message` already persisted). **Completes O2.**

## 1. Chat capture — the policy (decision 0021)

Trust-first, frozen before code:

- **No silent capture.** Asking a question stays fast-path (retrieve + answer,
  no enqueue). Capture is an **explicit "remember this"** affordance on a **user**
  message → the normal pipeline (extract → verify → embed → store → reconcile),
  `source_type = 'chat'`, `source_id = chat_message.id`. Provenance NOT NULL.
- **Assistant messages are never captured** — enforced at the endpoint (role
  check) AND the source reader (loads only `user` rows). Defense in depth.
- **Auto-capture toggle: DEFERRED**, explicitly, with **no dead UI**. When it
  ships, its memories must enter `uncertain` and go to Review.
- **Span selection deferred** (message-level in v1), no dead UI.
- **Scope = private by default** (the reader omits scope → embed-store defaults
  private); the user promotes via the O2-B change-scope action.
- **Source deletion runs the saga**: `ChatSourceDeletion` erases the
  `chat_message` row inside the enumeration transaction, so a chat-derived
  memory's source-delete produces a signed receipt exactly like a note.

## 2. Implementation

- **`ChatSourceReader`** (source_type `chat`) — loads a user message as a
  `SourceItem`; assistant rows return null. **`ChatSourceDeletion`** — the saga
  port. Both live in a global slim **`ChatSourceModule`** (DRIZZLE only), bound
  into ingestion's `SOURCE_READERS` (worker) and the memory saga's
  `sourceDeletions` (worker + app) — without dragging RetrievalService into the
  worker.
- **`ChatService.rememberMessage`** — owner + role gated, transactional enqueue
  via the outbox (idempotency-keyed, so a double-click captures at most once).
  **`captureState`** (pipeline progress) and **`messageContext`** (the message +
  surrounding turns for the drawer). Endpoints: `POST
  /api/chat/messages/:id/remember`, `GET …/capture-status`, `GET …/context`.
- **Frontend**: a "Remember this" control on user chat bubbles with a
  remembering → remembered indicator; the source drawer renders the framed chat
  conversation (target turn highlighted) for chat-sourced memories.
- **Source-type-agnostic paths verified by test**: a commitment stated in chat
  derives a task exactly like a note; the memory is `active`, `private`, with
  `chat` provenance; reconcile/temporal/deletion/receipt all treat it identically
  (deletion via the new saga port).

## 3. Seam test coverage (closes the audit finding)

- **Identity** (`identity/identity.service.spec.ts`, 6 tests): Principal built
  from a valid session (org + roles propagate — roles are the keys of the roles
  claim object); invalid/expired token → `UnauthorizedException`; missing subject
  → rejected; token caching; roles default `[]`. Plus an **architecture
  assertion** that no module outside the seam references Zitadel URLs, claims, or
  the userinfo client. `fetchUserinfo` is `vi.mock`ed — zero live Zitadel.
- **Model-gateway** (`model-gateway/model-gateway.seam.spec.ts`, 11 tests + 1
  live-optional): provider-neutral contract (`UnconfiguredModelGateway` throws
  not-configured for every method); typed **retryable-vs-fatal** classification
  (4xx fatal / no-retry, embedding-count mismatch retryable, the `retryable`
  flag); **Zod rejection** (malformed → fatal after one corrective retry;
  non-JSON → fatal, no retry) — via a spy on the private Mistral client, no
  network; **per-task tier selection** (pipeline vs answer, asserted on the model
  arg); **prompt-registry** load + version-format pin + **immutability** (a
  changed body for a recorded version throws). A live embed test is
  `skipIf(!MISTRAL_API_KEY)`. Plus an **architecture assertion** that no module
  outside the gateway imports `@mistralai`.

## 4. Corpus tick

8 chat-sourced golden cases (**4 en, 4 hr**, `source_type: "chat"`), Croatian
authored idiomatically (not translated):

- **Extraction**: a stated decision (`en-0027`, `hr-0015`), a stated commitment
  that derives a task (`en-0028`, `hr-0016`), a stated temporal fact with
  `valid_until` (`en-0029`, `hr-0017`).
- **Task closure** (`task-pair.json`, family `closure`, expected `closes`):
  `en-t006`, `hr-t006` — a chat-stated fulfillment closes a task like a note.

Corpus now **44 en / 30 hr** subdirs. `CHANGELOG.md` updated; both eval suites
run; `docs/eval/history.md` appended. **All gates PASS, no regression** (see the
report for numbers).

## What O2-C deliberately did NOT do

- The **auto-capture Settings toggle** (deferred by decision 0021 — no dead UI).
- **Span-level** capture (message-level only in v1).
- A standalone **chat-history deletion** UI (source deletion of a chat-derived
  memory already runs the saga; a "delete this conversation" surface is later and
  must route through the same saga).
