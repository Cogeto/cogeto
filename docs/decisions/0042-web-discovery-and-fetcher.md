# 0042 — Web discovery and the narrow fetcher (Priority 5 Part A)

Date: 2026-07-22. Status: accepted. Context: Post-v1 Backlog Priority 5
(web research), Part A — discovery, fetching, extraction infrastructure.
Part B (query minimisation + the approval gate) follows separately.

## Ruling 1 — Discovery is a distinct capability, not model inference

Discovery (query → ranked public URLs) is served by a **self-hosted SearXNG
container** inside the instance (compose profile `research`, image
digest-pinned per QS-25). It is a capability of its own, deliberately NOT
routed through the model gateway:

- It performs no inference — it queries public search engines and relays
  ranked results (URL, title, snippet). No API key, no vendor, no per-query
  cost, roughly 100–200 MB RSS.
- It has its own caps: a hard result cap per query
  (`COGETO_RESEARCH_RESULT_CAP`, default 8) and a hard timeout
  (`COGETO_RESEARCH_SEARCH_TIMEOUT_SECONDS`, default 10).
- Its failure semantics are **graceful unavailability, never an error path**:
  a down, rate-limited, or unconfigured engine yields a typed
  `search unavailable — try again` outcome the UI can surface verbatim
  (HTTP 503, code `search_unavailable`). Discovery being down affects nothing
  else on the instance.

Privacy posture: internal network only (no published ports — asserted by
`searx_internal_only`), metrics disabled, queries POSTed (never in URLs or
request-line logs), no query persistence. The curated engine set (DuckDuckGo,
Brave, Mojeek, Wikipedia) is chosen to tolerate datacenter IPs; Google/Bing/
Startpage hard-block or CAPTCHA that traffic and stay off. The set and the
adjustment procedure live in `project/infra/docker/searxng/settings.yml`.

## Ruling 2 — The fetcher is narrow by construction

Retrieval is a Cogeto-owned server-side fetcher (`WebFetchService`), not a
crawler and not a browser:

- **SSRF guard**: http(s) only; every hop — the initial URL and each redirect
  target — is DNS-resolved and refused when any answer is private, loopback,
  link-local, CGNAT, or multicast (v4 and v6, including v4-mapped). This is
  the first outbound URL path in the codebase; the guard applies the upload
  hardening posture (typed permanent refusals, defence in depth) to it.
- **robots.txt honoured** per origin (token `CogetoResearch`); a disallowed
  path is skipped and annotated, never fetched.
- **Hard caps**: per-page timeout, response-size cap (streamed and aborted at
  the cap), content-type restriction to HTML + PDF (anything else skipped and
  annotated), and a per-research page cap plus daily budgets (decision 0043).
- **Fetch-and-parse, never render**: no script execution, no resource
  loading. HTML → readable text via a deterministic, dependency-free
  boilerplate stripper (`html-text.ts`, the email-preprocessing spirit:
  drop script/style/nav/chrome subtrees, prefer `<article>`/`<main>`, strip
  tags, decode entities). PDFs reuse the existing `extractDocumentText`
  (pdf-parse + QS-6 parse caps). A full Readability port was considered and
  deferred: it would add two dependencies (a readability library + a DOM
  implementation) for marginal gain on the pages research targets; the seam
  (`extractReadableHtml`) is one function, swappable later with owner
  sign-off.

Known accepted limits (documented, not hidden): DNS is re-resolved by the
runtime at connect time, so a TOCTOU rebinding window exists between the
guard's check and the fetch — acceptable for a single-tenant, explicitly
invoked, budget-capped path, and the per-hop re-validation still blocks the
practical redirect attacks. The robots evaluation is longest-prefix-match
(Allow/Disallow), not the full wildcard grammar.

## Ruling 3 — Extraction stays on the pipeline tier

Fetched text enters the EXISTING ingestion pipeline (chunk → extract →
verify → embed → reconcile) as a normal source. Extraction and verification
therefore run on the **pipeline tier** structurally — `extractStructured`
defaults there, and the pipeline never calls `complete`/`completeStream`
(asserted by `extraction_pipeline_tier`). The answer tier is reserved for
user-facing synthesis; this is the token-control point that keeps research
economical. Chunks stay transient (§4.9), and long pages go through the
existing chunker unchanged.

## Named tests

`searx_client_contract` (connectors `web-discovery.spec`),
`searx_internal_only` (entrypoints `deployment-hardening.spec`),
`fetcher_hardening` (connectors `web-fetch.spec`),
`extraction_pipeline_tier` (connectors `web-research.integration.spec`).
