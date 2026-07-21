# Create a task from chat (Priority 1b)

**Decision 0038 · migration 0025 (shared with 0037) · issue #168.**

"Make a task to send Ana the revised mapping once she confirms the format",
"remind me to follow up with Marko next week", "dodaj zadatak: …" now create
a task in the flow of conversation:

- Detection is a deterministic `create_task` intent in the query-rewrite
  layer (en + hr trigger lexicon, question veto), checked before the
  reply-draft intent. No model decides whether.
- A clear request stores a normalized commitment form on the user's message
  (`chat_message.capture_content`, served by `ChatSourceReader` as the
  extraction input) and routes the message through the **existing** chat
  capture → commitment extraction → task derivation path. No task rows are
  created directly; conditions ("once she confirms …") populate
  `condition_text` so the task starts `blocked_on_condition`, exactly like a
  written note. Provenance is `source_type 'chat'` → decision 0037's
  conclusion logic applies to the task later.
- References to earlier turns resolve via the rewriter (it already holds the
  recent history); an unresolvable reference gets a concise clarifying
  question and creates nothing; a bare trigger creates nothing and says so.
- The confirmation (with the detected condition and a pointer to the Tasks
  page) is a deterministic string, en or hr per the matched trigger.

Tests: `chat_create_task_basic`, `chat_create_task_with_condition`,
`chat_create_task_ambiguous`, `chat_create_task_none`,
`chat_create_task_provenance` in
`project/src/retrieval/chat/chat-create-task.integration.spec.ts`, plus
golden chat cases `create_task_en_conditioned` and `create_task_hr_uvjet`
with the new deterministic `task_created` gate check.
