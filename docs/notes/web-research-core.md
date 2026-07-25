# Web research core (Priority 5 Part A)

Part A of the web-research capability (Post-v1 Backlog Priority 5; decisions
[0042](../decisions/0042-web-discovery-and-fetcher.md) and
[0043](../decisions/0043-web-source-and-retention.md)): private discovery,
the narrow fetcher, and web pages as first-class sources with URL provenance.
Part B (query minimisation + the show-edit-approve gate) is the next unit —
until it lands, the search/capture endpoints are the raw capability.

## Architecture (one pass)

```
user query ──► POST /api/research/search ──► SearXNG (self-hosted, internal)
                    │ budget: research_search        │ curated public engines
                    ▼                                ▼
              ranked URLs (title + snippet, hard cap)
                    │  user selects
                    ▼
        POST /api/research/capture ──► WebFetchService (SSRF guard, robots,
                    │ budget: research_page          size/type/timeout caps,
                    ▼                                fetch-and-parse only)
        web_page row (retained clean text + URL + fetched_at)
                    │ outbox → ingestion.pipeline (source_type 'web')
                    ▼
        chunk → extract → verify → embed → reconcile   (pipeline tier ONLY)
                    ▼
        memories with provenance web_page.id — URL + fetch time in the drawer
```

- **No crawler.** Discovery returns URLs; only user-selected pages are
  fetched; each research is page-capped; everything is budget-gated per user
  per day.
- **Explicitly invoked, never ambient.** Nothing fetches without a user
  action, and Part B will additionally show-and-approve what leaves.

## Discovery — SearXNG

- Compose profile `research`, digest-pinned image, **no published ports**
  (`searx_internal_only` asserts it), reachable only as
  `http://searxng:8080` from the app.
- Engine set (curated for datacenter-IP tolerance): DuckDuckGo, Brave,
  Mojeek, Wikipedia. Google/Bing/Startpage CAPTCHA or block datacenter
  traffic — deliberately off. Adjust in
  `project/infra/docker/searxng/settings.yml` (`keep_only` list); no image
  rebuild needed.
- No query logging: metrics disabled, the client POSTs queries (never in
  URLs), SearXNG persists nothing; Cogeto's own logs never carry the query
  either.
- Failure semantics: down/rate-limited/unconfigured → HTTP 503
  `search_unavailable` with a user-ready message. `~100–200 MB` RSS.

## The fetcher — hardening summary

| Control | Value / behaviour |
|---|---|
| Schemes | http/https only |
| SSRF | every hop DNS-checked; private/loopback/link-local/CGNAT refused (v4+v6) |
| Redirects | max 5, each target re-validated |
| robots.txt | honoured per origin (token `CogetoResearch`); disallow → skip |
| Timeout | `COGETO_RESEARCH_FETCH_TIMEOUT_SECONDS` (15 s) per page |
| Size cap | `COGETO_RESEARCH_FETCH_MAX_BYTES` (5 MB), streamed + aborted |
| Types | text/html + application/pdf; others skipped and annotated |
| Scripts | never executed — regex strip, no DOM, no rendering |
| Extraction | `extractReadableHtml` (boilerplate stripped) / `extractDocumentText` for PDF |

## Caps and budgets (FIX-2 infrastructure)

Per user per calendar day, in-memory counters, demo namespace tighter:
`COGETO_DAILY_RESEARCH_SEARCHES` (40 / demo 10),
`COGETO_DAILY_RESEARCH_PAGES` (100 / demo 20); per capture request
`COGETO_RESEARCH_PAGES_PER_RUN` (5); per query
`COGETO_RESEARCH_RESULT_CAP` (8). Exhaustion → 429 `daily_research_limit`
("try again tomorrow"); mid-capture exhaustion annotates remaining URLs.
Extraction runs on the **pipeline tier** — the answer tier is never touched
by ingestion (`extraction_pipeline_tier`).

## Retention decision (0043 ruling 2)

Default: **retained clean text + URL** on the `web_page` row — the source of
record. Optional: `COGETO_RESEARCH_RETAIN_HTML=1` stores the sanitised raw
HTML as a scoped, encrypted MinIO object (`…/web-<id>.html`). Both paths are
fully deletion-covered; the receipt counts the object when present.

## Deletion, temporality

- `requestSourceDeletion(principal, 'web', id)` removes the row, the derived
  memories, the Qdrant points, and any retained HTML object under ONE
  receipt; sweep-clean (`web_deletion_cascade`).
- Validity intervals anchor to `fetched_at` ("as of the fetch"); a newer
  fetch supersedes an older claim and closes its interval
  (`web_facts_temporal`).

## Demo (local)

```sh
docker compose --profile research up -d      # stack + SearXNG
# then, authenticated as a user:
POST /api/research/search  {"query": "adriatic foods wholesale terms"}
POST /api/research/capture {"urls": ["https://…"]}
# watch the memories arrive; open one → source drawer shows URL + fetch time
```

With the profile down, search answers 503 `search_unavailable` and the rest
of the instance is unaffected.

## Named tests

`searx_client_contract`, `searx_internal_only`, `fetcher_hardening`,
`extraction_pipeline_tier`, `web_source_provenance`, `web_facts_temporal`,
`web_deletion_cascade`, `research_budget_enforced`. Golden: `en-w001` +
`hr-w001` (fetcher-output fixtures; see the golden CHANGELOG).

## Speed and conclusion (decision 0057, 2026-07-25)

Big pages stopped being slow and leaving the chat stopped losing the answer:

- **Focused extraction**: pages captured under an approved run store
  `web_page.extraction_text` — the 6 chunks most relevant to the sent query,
  ranked by embeddings only at capture time; the reader prefers it, the full
  `retained_text` stays the source of record. Small or query-less pages skip
  it (NULL) and extract whole.
- **Web fact budget**: `WEB_MAX_FACTS = 30` (pipeline.service) over the QS-6
  cap of 100 — reference pages contribute salient facts, not page noise.
- **Batched verification**: multi-fact sources verify 10 claims per call via
  `verification/v0005` (v0004's rubric, batch envelope); single-fact sources
  keep v0004. An omitted claim is conservatively unsupported.
- **Server-side conclusion**: when a run's last page settles (done or
  dead-lettered), the worker's `research.conclude` job synthesises and STORES
  the answer (`research_run.status = 'concluded'`, migration 0032). The
  worker synthesis has no retrieval, so stored answers cite pages only.
- **Chat resume**: the chat page re-mounts the newest in-flight or
  concluded-but-unseen run (48 h window); a concluded run replays the stored
  answer via `POST /runs/:id/synthesise` (no model call, marks seen);
  `answer_seen_at` retires it from the resume surface.
