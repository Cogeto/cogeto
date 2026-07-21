# 0038 — Create a task from chat (the create_task intent)

**Date:** 2026-07-21 · **Status:** accepted · **Governs:** the explicit
conversational intent that creates a task from chat (Post-v1 Backlog
Priority 1b): detection, ambiguity handling, the capture path, and how it
squares with the chat-capture policy. **Driven by:** decision 0021 (chat
capture), 0013 ruling 2 (derivation is engine-only), the reply-draft intent
pattern (Session O4), and the Priority-1 owner prompt. Shares migration
**0025** with decision 0037 (`chat_message.capture_content`).

## Ruling 1 — Detection is deterministic, en + hr, question-vetoed

`create_task` joins the deterministic intent family in the query-rewrite
layer (`detectCreateTaskIntent`): a trigger lexicon ("make/create/add a
task (to|:)…", "remind me to…", "napravi/dodaj zadatak da…", "podsjeti me
da…") both detects the request and extracts the instruction — no model
decides WHETHER. Leading interrogatives veto ("did I make a task…", "jesam
li…" are retrieval, not creation); polite request forms ("can you make a
task to…") deliberately pass. The branch runs **before** the reply-draft
intent so "remind me to reply to Ana" makes a task, not a draft.

## Ruling 2 — The capture reuses the 0021 path; no task rows are written

A clear request routes **the user's own message** through the normal chat
capture: the pipeline is enqueued transactionally on `(chat, message_id)`
exactly as "remember this" (same idempotency key — a message is captured at
most once), extraction produces the commitment (with its condition in the
claim), and the **task engine derives the task** with conditions, due dates,
entities, and closure tracking identical to a note-derived task. The intent
handler never creates a task row and never sends or mutates anything else.
The deriving memory's provenance is honestly `source_type 'chat'`, so
decision 0037's conclusion logic applies to the task later.

This does not breach 0021 ruling 1 ("asking a question never creates a
memory"): an explicit create-task request is not a question — it is the
"remember this" affordance spoken in words, deterministically detected, and
it captures only the user's own message (ruling 4 untouched).

## Ruling 3 — capture_content: the extraction input, made durable

The raw message ("make a task to send Ana…") is a meta-instruction the
extractor should not memorize verbatim, so the handler stores a normalized
commitment form on the message — `capture_content` = `Task: <instruction>`
(hr: `Zadatak: <instruction>`) — and `ChatSourceReader` serves it as the
extraction input when present. The raw message is untouched and remains the
§A.6 provenance target; the source drawer still renders the conversation.
This is the chunk concept made durable: transient extraction input, recorded
so re-delivery extracts the same thing. NULL for every message not captured
as a task request; "remember this" behavior is unchanged.

## Ruling 4 — Ambiguity asks; nothing actionable creates nothing

References to earlier turns resolve through the rewriter (which already
holds the recent history) — but only when needed: an instruction with a
named entity proceeds deterministically. If after resolution the instruction
still leans on an unresolved reference ("send her the mapping" with no
antecedent the rewriter can pin), the assistant asks a concise clarifying
question and creates nothing; a bare trigger ("add a task") gets a plain
"nothing actionable" and creates nothing. Confirmation, ambiguity, and
nothing-actionable replies are deterministic strings (en/hr per the matched
trigger) pointing at the Tasks page; no model writes them.

## Eval

Two golden chat cases (`create_task_en_conditioned`, `create_task_hr_uvjet`)
create a conditioned task end-to-end; the harness runs the real pipeline +
engine on the capture and the new deterministic `task_created` check joins
the all-must-pass rule gate (decision 0036 arithmetic unchanged).
