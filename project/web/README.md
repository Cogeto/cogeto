# web — chat + dashboard frontend

The frontend for Cogeto's two surfaces (scope §4.0), served by the **app** process:

- **Chat** (primary) — ask, act, approve; the fast path lives behind it.
- **Memory dashboard** (governance) — see/search/edit/correct/delete memories, status
  flags, source links, the "Forgotten" section with deletion receipts (§B.1), and
  dead-letter job visibility (§A.3).

This is a UI layer only: it talks to the app process's API and holds no business
logic — approval is decided server-side (§A.8), never here.

May depend on: the app API. Nothing in `src/` depends on it.
