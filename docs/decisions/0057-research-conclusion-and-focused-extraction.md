# 0057 — Research concludes server-side; web extraction is focused and batched

**Date:** 2026-07-25 · **Status:** accepted · **Governs:** the focused
extraction view for fetched pages, the web-source fact budget, batched
verification, the research run's terminal state, and the chat resume surface
(issues #254/#255). **Driven by:** decisions 0042/0043 (web sources),
0044/0045 (the gate), 0047/0050 (the in-chat flow), and the owner's field
report: a 60k-char page spent hours in an extraction retry loop, and leaving
the chat mid-research lost the response entirely. Migration this session is
**0032**; prompt this session is **verification/v0005**.

The measured shape of the problem: one large page → ~11 chunks → the QS-6
worst case of 100 facts → ONE verification call per fact — 150 to 250
sequential model calls inside a single job transaction, restarted from zero by
any mid-flight failure. And the entire post-approval flow (progress polling,
conclusion, the answer) lived in the mounted chat component, so navigating
away orphaned the run in 'approved' forever.

## Ruling 1 — The machine reduces before the model reads (focused extraction)

At capture time, a page fetched under an approved run is split with the SAME
chunker extraction uses, the chunks are ranked against the run's `sent_query`
by **embeddings only** (one batched embed call, no completions), and the top
6 chunks — document order — are stored as `web_page.extraction_text`. The
reader prefers it; `retained_text` stays complete as the source of record
(drawer, synthesis excerpts, audits, deletion receipts). Pages under 7 chunks,
query-less direct captures, and any focus failure store NULL and extract whole
— focusing is an optimisation, never a gate.

## Ruling 2 — Web sources have a fact budget

`WEB_MAX_FACTS = 30` (over the QS-6 cap of 100, which stands for first-person
sources). A fetched page is reference material: it contributes salient facts,
never a hundred rows of page noise — and the budget bounds the
verify/reconcile/embed fan-out that made big pages slow.

## Ruling 3 — Verification batches; the independent pass stands

Multi-fact sources are verified in batches of **10 claims per structured
call** through `verification/v0005` — v0004's rubric verbatim, only the
envelope changes (numbered claim/passage/context blocks in, a `verdicts`
array out, every claim judged independently against its own evidence).
Single-fact sources keep v0004 untouched. A claim the reply omits is
**unsupported** (conservative: it admits as `uncertain`). §B.3 holds: the
verifier stays a separate prompt family with no extractor wording; the §B.4
golden gate (verification_agreement ≥ 0.75) polices the batch form like any
prompt change. Net effect with rulings 1–2: a big page drops from 150–250
calls to roughly 15–20.

## Ruling 4 — The worker concludes the run; the answer cannot be lost

`research_run` gains the terminal success state **'concluded'** (+
`concluded_at`, `answer_seen_at`; migration 0032). Inside the SAME idempotency
transaction that processes a web page's pipeline job, the worker checks the
page's run: when every captured page has settled (done or dead-lettered — a
permanently failed page must not hold the answer hostage), it enqueues
`research.conclude` transactionally. That job synthesises and **stores** the
answer on the run row — whether or not anyone is watching. Conclusion is
idempotent by construction (only 'approved' concludes; 'concluded' is
terminal); failures retry with backoff and park visibly in dead_letter with
the run still approved. The worker synthesis runs **without retrieval**
(deliberately not composed there), so stored answers cite pages ([W#]) only;
interactive synthesis keeps memory citations ([M#]).

## Ruling 5 — Chat resumes; seen is explicit

The chat page picks back up the newest run that is approved-and-in-flight or
concluded-but-unseen (48-hour window; the Research page owns anything older).
A resumed approved run shows live page progress from the queue ledgers; a
concluded run replays the STORED answer through the synthesise endpoint —
which returns it without a model call and marks it seen. `answer_seen_at`
(set by replay, by the interactive flow, or by `POST /runs/:id/seen`) is what
retires a run from the resume surface — it never re-shows.

## Named tests

`web_fact_cap`, `admission_rule` (batch call count + v0005 pinning)
(`project/src/ingestion/pipeline.integration.spec.ts`);
`batched_verification` (`project/src/ingestion/pipeline/verify-batch.spec.ts`);
`research_concludes_server_side`, `resume_replay_marks_seen`,
`conclusion_idempotent`, `focused_extraction`
(`project/src/connectors/research-conclusion.integration.spec.ts`);
`research_resume` (`project/web/src/components/research-resume.spec.ts`).
