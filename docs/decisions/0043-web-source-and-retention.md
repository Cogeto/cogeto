# 0043 — Web as a first-class source: retention, temporality, budgets

Date: 2026-07-22. Status: accepted. Context: Post-v1 Backlog Priority 5
Part A (with decision 0042); migration 0027.

## Ruling 1 — source_type 'web' and the web_page source row

Fetched pages the user selects for capture become first-class sources:
`source_type` gains `'web'`, and the connectors-owned `web_page` table is the
durable source row (owner, scope — default `private`, the researching user
owns them — the requested and final URLs, title, fetch timestamp, retained
text, optional raw-HTML object key). Derived memories carry §A.6 provenance
`source_type = 'web'` → `web_page.id`, so a web fact is visibly a web fact
and its URL + fetch time are one click away in the source drawer.

## Ruling 2 — Retention: clean text + URL; raw HTML optional, off by default

The **retained extracted text plus the URL is the source of record**. That is
what verification cites, what the drawer shows, and what re-processing would
re-extract from. The raw HTML is NOT retained by default: it is bulky, full
of tracking noise, and the live page is one click away at the recorded URL.
`COGETO_RESEARCH_RETAIN_HTML=1` opts in to additionally storing the
**sanitised** HTML (the email-intake sanitiser: scripts/handlers/js: URLs
stripped) in MinIO under the scoped key scheme
(`org/user/scope/web-<id>.html`, SSE-encrypted bucket), recorded on
`web_page.raw_object_key` and fully covered by the deletion cascade either
way.

## Ruling 3 — Temporal honesty: the fetch time is the anchor

A web fact ages like every other fact. The web SourceReader passes
`fetched_at` as the source timestamp, so extraction's REFERENCE TIME — and
every resolved validity interval — anchors to **when Cogeto read the page**,
which is exactly what a web claim can honestly assert ("as of the fetch").
Web facts get validity intervals, participate in reconciliation, supersession
and dreaming; a newer fetch of changed content supersedes the older claim and
closes its interval (`web_facts_temporal`).

## Ruling 4 — Deletion coverage without saga changes

`WebSourceDeletion` implements the existing `SourceDeletion` port: the saga
enumerates the page's memories by provenance (as for every source), the
adapter deletes the `web_page` row and hands the optional raw-HTML object to
the SAME receipt via `enumerateCascade`; `ownsObjectKeys` keeps the integrity
sweep's orphan arm honest about live retained objects. No saga or receipt
schema change (`web_deletion_cascade`).

## Ruling 5 — Budgets before model spend

Research is explicitly invoked, never ambient, and budget-gated with the
existing FIX-2 infrastructure (DailyCounters buckets `research_search` /
`research_page`): per-user daily caps on searches
(`COGETO_DAILY_RESEARCH_SEARCHES`, default 40) and fetched pages
(`COGETO_DAILY_RESEARCH_PAGES`, default 100; demo namespace tightens both),
plus a per-request page cap (`COGETO_RESEARCH_PAGES_PER_RUN`, default 5).
Exhaustion yields a clear, typed limit-reached message (429
`daily_research_limit`); a mid-capture exhaustion annotates the remaining
URLs instead of failing the request (`research_budget_enforced`). The caps
sit BEFORE the fetch/extraction, so they bound outbound traffic and pipeline
model work alike; the per-user model budget (QS-2) still applies on top.

## Ruling 6 — Deploy channel

Like the redaction profile (decision 0030), the `research` profile ships in
the dev/build compose only for now; the pull-only deploy stack gains it when
the research capability (Part B's approval gate included) is released to the
channel. Nothing in the app breaks with the profile absent — discovery
reports "search unavailable".

## Named tests

`web_source_provenance`, `web_facts_temporal`, `research_budget_enforced`
(connectors `web-research.integration.spec`), `web_deletion_cascade` (memory
`web-deletion-cascade.integration.spec`). Golden: `en-w001`, `hr-w001`.
