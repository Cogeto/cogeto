# Web research privacy (Priority 5 Part B)

Part B completes the research capability
([`web-research-core.md`](web-research-core.md) is Part A): query minimisation
(decision [0044](../decisions/0044-research-query-minimisation.md)), the
show-edit-approve gate (decision
[0045](../decisions/0045-research-gate-and-invocation.md)), chat invocation,
and per-claim-cited synthesis. **Priority 5 is now delivered in full.**

## The honesty story, stated exactly

A search query leaves the instance — nothing changes that, and Cogeto never
claims otherwise. What Cogeto claims, and enforces, is:

1. **It minimises what leaves.** A pipeline-tier pass (prompt family
   `research_query_minimise`) rewrites the proposed query to the
   least-identifying form that still serves the intent: client names and
   identifying specifics go when the intent is general; an entity stays when
   researching it is the point; when unsure, it stays and you decide.
2. **You see precisely what leaves.** The gate shows the minimised query, the
   original it replaced, and a one-line reason for what was removed or kept.
   You can edit the text freely.
3. **You approve or cancel before it goes.** Discovery runs only from an
   approved `research_run` row (schema-enforced — the raw search endpoint from
   Part A is gone). Cancel sends nothing, ever. Transitions are audit-logged.
4. **The sent query is provenance.** The exact approved text is recorded on
   the run; captured pages link to it, so every research-derived memory
   answers "what was searched to learn this?" months later, in the source
   drawer, next to the URL and fetch time.

If minimisation itself is unavailable, the query passes through UNCHANGED with
an honest reason — safe because of the gate: the failure mode is "review it
yourself", never "silently sent".

## The flow

```
chat: "research …" / Research page input
      → propose: minimise (pipeline tier) + record research_run (status proposed)
      → THE GATE: minimised query + reason shown; edit freely | cancel (sends nothing)
      → approve: sent_query recorded immutably → discovery runs (SearXNG)
      → pick pages (caps + budgets, Part A) → fetch → web_page rows (run-tagged)
      → pipeline: extract/verify/embed on the pipeline tier → web memories
      → synthesise (answer tier): [W#] → URL + fetch time, [M#] → memory,
        model knowledge marked (unsourced); the answer persists on the run
```

Chat only OPENS the gate (the `CHAT_RESEARCH_RESOLVER` seam, app-root only) —
it can never approve. Triggers are imperative and anchored (`research …`,
`look up …`, `search the web for …`; hr `istraži …`, `potraži na webu …`);
an ordinary question never searches (`not_ambient`). The Research page is the
gate, the results picker, and the answer view; past runs list what was sent —
or that nothing was. Since decision 0047 the same gate also renders inline in
the chat surface (same endpoints, same server-side approval, same audit) —
see [`natural-conversation.md`](natural-conversation.md).

## The gate mechanism (why not the approval machine)

The §A.8 approval machine executes approved actions in the worker —
asynchronous by design, wrong for an interactive search. The `research_run`
record keeps its honesty properties (server-side state the effect is
impossible without; explicit user action; audit trail; owner-only) in a
synchronous shape. Approve-with-same-text retries a flaky engine; a different
text needs a new run; `sent_query` never mutates. See 0045 ruling 1.

## Compliance one-pager content note

The website one-pager's web-research line (owner-maintained; this is the
source text): *Web research is explicitly invoked, never ambient. Queries are
minimised by a local pass, shown verbatim to the user, and sent only on their
approval; the sent query is recorded in the provenance of every resulting
memory. Pages are fetched by the tenant's own instance (no third-party
research API), robots-respecting, and stored as inspectable, deletable
sources with URL and fetch-time provenance.*

## Named tests

`minimise_drops_client`, `minimise_keeps_subject`, `minimise_reports`
(research-minimise.spec); `no_query_without_approval`, `edited_query_used`
(research-gate.integration); `sent_query_in_provenance`,
`research_creates_memories`, `research_answer_cited`
(research-flow.integration); `research_intent_gated`, `not_ambient`
(chat-research-intent.integration + research-intent.spec). Live:
`research_minimise_drop` + `research_keeps_subject_hr` (chat eval).

## Demo

1. In chat: *"research GDPR consent requirements for our client Adriatic
   Foods when migrating our CRM"* → the reply discloses the minimised query
   (client name gone, reason given) and states nothing has been sent.
2. On **Research**: edit the query if you like → **Approve & search** (or
   **Cancel — send nothing**: confirm in the audit log that only
   `research_run.proposed` / `.cancelled` exist and SearXNG logs show no
   query). → pick pages → fetch → **Synthesise a cited answer**.
3. Every web claim's `[W#]` links to the page (title + fetch time on hover);
   the facts appear under Memories as web sources; the source drawer shows
   URL, fetch time, AND the sent query; deleting the source issues a receipt.

## Frictionless chat research (decision 0050, 2026-07-24)

Owner UX change: in **chat**, the show-edit-approve gate and manual page-picking
were removed. The "Research this on the web" tap is the consent; the minimised
query is sent immediately; Cogeto auto-reads the **top 3 sources by SearXNG
relevance score** (`selectTopByScore` in `@cogeto/shared`; discovery now keeps
the `score` it used to discard). An opt-in **Research automatically** setting
(`cogeto-auto-research`, localStorage, off by default; Settings → Web research +
a "Always do this automatically" affordance) skips even the tap. Preserved: query
minimisation, in-flow disclosure of the sent query + sources read, and
`research_run.sent_query` provenance. The **Research page keeps the full
edit/approve gate + manual selection** as the control surface.
