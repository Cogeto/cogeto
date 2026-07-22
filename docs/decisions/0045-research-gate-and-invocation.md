# 0045 — The research gate and invocation (Priority 5 Part B)

Date: 2026-07-22. Status: accepted. Context: with decision 0044; migration
0028. Completes Priority 5.

## Ruling 1 — A research run record, not the approval machine

Every research invocation creates a `research_run` row: intent, proposed
query, minimised query + reason, status (`proposed` → `approved` |
`cancelled`), and — set ONLY by explicit approval — `sent_query`, the exact
text that left. Discovery runs solely from an approved row; the Part A raw
`POST /api/research/search` endpoint is REMOVED. Transitions are audit-logged
(`research_run.proposed/approved/cancelled` — structural detail only, QS-1;
the query text lives on the owner-gated row).

The full approval machine (§A.8) was considered and deliberately not used:
its execution leg is worker-async by design (confirm only enqueues), which is
right for consequential side effects and wrong for an interactive search the
user is waiting on. The gate keeps the machine's honesty properties —
server-side state that the effect is impossible without, explicit user
action, audit-logged transitions, owner-only access — in a synchronous shape.
A research query is also not a "consequential action" in the §A.8 sense: it
changes nothing; it discloses.

## Ruling 2 — Show, edit, approve; the record is immutable

The gate shows the minimised query, the original it replaced, and the
one-line reason. The user edits the text freely or cancels; only explicit
approval sends, and what is recorded is the user's final text — the honest
claim is exactly: "Cogeto minimises what leaves, shows you precisely what
leaves, and you approve or cancel it before it goes." An approved run may
retry discovery with the SAME recorded query (engine hiccups); a different
text requires a new run — `sent_query` never mutates. Cancelled is terminal.

## Ruling 3 — The sent query is provenance

Captured pages carry `web_page.research_run_id`, so every research-derived
memory resolves memory → web_page → `research_run.sent_query`: months later
the source drawer answers "what exactly was searched to learn this fact?"
alongside the URL and fetch time (0043).

## Ruling 4 — Invocation is explicit; synthesis is per-claim honest

Chat detects an imperative research trigger (deterministic, en+hr, anchored —
`research …`, `look up …`, `istraži …`; an ordinary question NEVER triggers,
`not_ambient`) and only OPENS the gate via the CHAT_RESEARCH_RESOLVER seam
(the reply-resolver pattern; app root only). The Research page is the explicit
UI action and the gate itself. Synthesis runs on the answer tier — the only
research stage that uses it — over the run's captured pages plus retrieved
memories: `[W#]` markers resolve to URL + fetch time, `[M#]` to memory
citations, model knowledge is marked `(unsourced)`, and unresolvable markers
are stripped before storing (the chat sanitize rule). The research yields the
answer AND durable web memories, so the next question benefits without
re-searching.

## Verification

`no_query_without_approval`, `edited_query_used` (research-gate integration),
`sent_query_in_provenance`, `research_creates_memories`,
`research_answer_cited` (research-flow integration), `research_intent_gated`,
`not_ambient` (chat-research-intent integration + detector unit), and the two
live research chat-eval cases (0044).
