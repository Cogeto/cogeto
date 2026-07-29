# Named skills

Agents whose every step is inspectable, every fact sourced, and every consequential
action waits for you. The first skill does a whole job end to end: say "research
Adriatic Foods before Thursday" and Cogeto gathers what you already know, proposes
minimised searches you approve in one interaction, reads the approved pages through
the normal pipeline, and hands back a brief where what you knew cites your memories,
what is new cites its URL and fetch time, and contradictions between the two are
stated rather than silently resolved.

## A skill is a code-defined, versioned plan of typed steps

An ordered set of steps, each with a kind: `gather_from_memory`, `propose_searches`,
`gated_search`, `fetch_and_extract`, `verify`, `synthesise`.

Skills are **code artifacts in a registry**, versioned exactly like prompts
(`research_brief/v0002`), and are not user-programmable. **The registry entry is the
contract**: the run's step log is created from it, so a finished run is always
readable against the plan that produced it, and a change to the declared plan bumps
the version. Runs recorded under an older version keep their step log and stay
readable against the declaration they ran under.

The runtime lives in **connectors**, beside the research machinery it orchestrates.
The `agents` module cannot host it without a cycle, and governance still flows
*through* the approval machine rather than around it.

## The run record is the inspectability claim

`skill_run` holds the skill id and version, owner, subject, status (`planning`,
`awaiting_approval`, `running`, `awaiting_input`, `completed`, `failed`,
`cancelled`), the brief and its citations, and timestamps.

`skill_run_step` holds **one row per plan step**: status, an inputs summary, an
outputs summary, and `links` (research run ids, page ids, memory ids, counts) so
every artifact a step produced is one click away. Every status transition is
audit-logged structurally, never with content.

The step row **is** the checkpoint. Persisted rows plus the job queue, no graph
runtime.

## The research gate survives at plan granularity

A skill's query plan is **N ordinary `research_run` rows**, one per proposed query,
tagged with the skill run, created in `proposed` and shown together at the gate. You
approve the plan in one interaction: approve all, edit any, remove any. The approval
endpoint flips each kept run to `approved` with its (possibly edited) text as
`sent_query` and cancels the removed ones.

**Nothing is carved through the invariant.** Discovery still runs only from an
approved run, the sent query is still recorded immutably, and provenance
(memory → web_page → sent_query) is byte-identical to manual research.

Skill queries are **generated**, not typed by the user, so minimisation happens at
generation: the planning prompt is instructed to produce the least-identifying
queries that serve the intent, and each run's reason says so. If the planning model
is unavailable, deterministic fallback queries are proposed with an honest reason.
The failure mode is "review it yourself", never "silently sent".

## Skills never create tasks, and consequential actions wait

Skill-observed obligations become **ordinary memories**; web sources never derive
follow-ups of their own. Any future skill action that writes outside the instance
routes through the approval machine. The runtime adds no second executor.

## Execution is worker-side, resumable, budget-capped, cancellable

Planning (a memory gather plus one planning call) runs in the propose request and
ends at `awaiting_approval`. Everything after approval is the worker's `skill.advance`
job: a re-runnable task that claims the next step, executes it, checkpoints, and
re-enqueues itself.

Search and capture reuse the research service verbatim, so budgets, the SSRF guard,
robots, and focused extraction all apply unchanged. The settle-watcher branches for
skill-owned runs: when all pages of all of a skill run's research runs settle, it
advances the skill instead of concluding each run, so skill research runs stay
`approved` and never store per-run answers.

Re-delivery is safe: searched queries are recorded in the step's links and skipped,
capture is guarded by existing pages, and terminal states are compare-and-set.

Budgets cap the plan at 6 queries and 3 pages per query, with the daily research
budgets applying unchanged underneath. **Hitting a cap is graceful**: remaining work
is skipped with an honest note in the step's outputs and the run completes with what
it has. Cancelling stops cleanly at the next step boundary and keeps everything
already produced.

## The brief

Written on the answer tier, the only skill stage that uses it. Memory and page
markers resolve to citations exactly as in chat, model knowledge is marked unsourced,
and unresolvable markers are stripped.

The brief text and its resolved citations **persist on the run row**, renderable
forever with live citation links, and the web memories persist as ordinary sources,
so the next question about the subject benefits without re-running. The finished run
stays open forever, with every search sent, page fetched, and memory created one
click away.

Where a web fact contradicts a stored memory, reconciliation flags it as always and
**the brief says so**: the verify step reports contradicted and uncertain counts, and
the prompt requires stating the tension rather than silently preferring either side.

Because the brief is Cogeto-initiated, it speaks the user's preferred language.
