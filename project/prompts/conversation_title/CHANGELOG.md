# conversation_title — changelog

Names an untitled conversation from its opening messages (P6.9, decision
0056). Pipeline tier; called once per conversation by the worker's
`conversation.title` job. The user's manual rename always wins over this.

## v0001 — 2026-07-24 (P6.9 multiple conversations)

Initial version. 2 to 6 plain words in the user's language, subject not act,
no invention; thin exchanges get a generic label. Strict JSON `{ "title" }`.
