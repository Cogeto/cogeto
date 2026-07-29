# Web research

Cogeto can read the public web, and it is honest about the one thing that genuinely
leaves the instance: the search query itself.

**The premise, stated plainly.** A web search query leaves the box. That is what
searching the public web means, and no architecture changes it. Pseudonymising the
query would break it ("ORG_1 GDPR consent CRM" finds nothing useful) while
un-swappable context would still identify. So the mechanism is **minimisation plus
disclosure plus provenance**, never a pretend-private search.

Runs under the `research` compose profile. With the profile absent nothing breaks;
discovery simply reports "search unavailable".

## Discovery is not inference

Query to ranked public URLs is served by a **self-hosted SearXNG container inside
the instance**, deliberately not routed through the model gateway. It performs no
inference: it queries public engines and relays ranked results. No API key, no
vendor, no per-query cost.

- Internal network only, no published ports, metrics disabled, queries POSTed so
  they never appear in URLs or request-line logs, no query persistence.
- Hard caps: results per query (default 8) and a search timeout (default 10s).
- **Graceful unavailability, never an error path.** A down, rate-limited, or
  unconfigured engine yields a typed "search unavailable, try again" the UI shows
  verbatim. Discovery being down affects nothing else on the instance.
- The curated engine set (DuckDuckGo, Brave, Mojeek, Wikipedia) is chosen to
  tolerate datacenter IPs. Google, Bing, and Startpage hard-block or CAPTCHA that
  traffic and stay off.

## The fetcher is narrow by construction

A Cogeto-owned server-side fetcher, not a crawler and not a browser.

- **SSRF guard.** http(s) only. Every hop, the initial URL and each redirect target,
  is DNS-resolved and refused when any answer is private, loopback, link-local,
  CGNAT, or multicast, for v4 and v6 including v4-mapped.
- **robots.txt honoured** per origin (token `CogetoResearch`). A disallowed path is
  skipped and annotated, never fetched.
- **Hard caps**: per-page timeout, a response-size cap enforced by streaming and
  aborting, content-type restricted to HTML and PDF, a per-run page cap, and daily
  budgets.
- **Fetch and parse, never render.** No script execution, no resource loading. HTML
  becomes readable text through a deterministic, dependency-free boilerplate stripper;
  PDFs reuse the document extractor.

Accepted limits, documented rather than hidden: DNS is re-resolved by the runtime at
connect time, so a TOCTOU rebinding window exists between the guard's check and the
fetch. That is acceptable for a single-tenant, explicitly invoked, budget-capped
path, and per-hop re-validation still blocks the practical redirect attacks. The
robots evaluation is longest-prefix-match, not the full wildcard grammar.

## Minimisation

A small-model rewrite on the **pipeline tier** through the normal gateway, so it is
itself redaction-wrapped when that profile is on. It returns the minimised query,
what was removed and kept, and a one-line reason shown verbatim.

**The subject rule**: drop an entity that merely anchors a general question
("Adriatic Foods GDPR consent CRM migration" becomes "GDPR consent requirements CRM
migration"); **keep** an entity that is itself the research subject; and **when
unsure, keep it**. The conservative failure mode is "asked the user", never
"silently leaked" and never "silently broke the search". Public entities such as
laws and regulations are topical substance and are kept freely.

**Failure opens to the user, never to the network.** If the minimisation call fails
the query is returned unchanged with an honest reason. A minimiser outage degrades
to manual review, not to leakage.

## The run record

Every invocation creates a `research_run` row: intent, proposed query, minimised
query and reason, status (`proposed` → `approved` | `cancelled` → `concluded`), and,
set only by approval, **`sent_query`**, the exact text that left. Discovery runs
solely from an approved row; there is no raw search endpoint. Transitions are
audit-logged structurally, with the query text on the owner-gated row.

The full approval machine was considered and deliberately not used: its execution leg
is worker-async by design, which is right for consequential side effects and wrong
for an interactive search the user is waiting on. A research query is also not a
consequential action in that sense: **it changes nothing, it discloses.** The run
record keeps the machine's honesty properties (server-side state the effect is
impossible without, explicit user action, audited transitions, owner-only access) in
a synchronous shape.

`sent_query` never mutates. An approved run may retry discovery with the same
recorded text; different text requires a new run. Cancelled is terminal.

**The sent query is provenance.** Captured pages carry their run id, so every
research-derived memory resolves memory → web_page → `research_run.sent_query`.
Months later the source drawer answers "what exactly was searched to learn this?"
alongside the URL and fetch time.

## Invocation, and where the gate lives

Chat detects a deterministic imperative trigger (en + hr, anchored: `research …`,
`look up …`, `istraži …`). **An ordinary question never triggers research.**

In **chat**, the tap is the consent. The query is still minimised, but it is sent
immediately, and Cogeto auto-selects the **top 3 sources by SearXNG relevance
score** rather than making you pick. An optional per-device always-on setting (off by
default) lets a knowledge answer that would offer research just run it.

The **standalone Research page keeps the full edit-and-approve gate and manual page
selection** as the control surface.

What is preserved either way: minimisation runs on every research; the exact query
that left and the sources read are disclosed in-flow and recorded in every derived
memory's provenance; the server-side owner-gated approve transition still happens.
The honest claim is therefore: *you invoke it, Cogeto minimises the query, and shows
and records exactly what left and what it read.*

## Web as a first-class source

`source_type` includes `'web'`, and the connectors-owned `web_page` table is the
durable source row: owner, scope (private by default), requested and final URLs,
title, fetch timestamp, retained text, and an optional raw-HTML object key.

- **Retention.** The extracted text plus the URL is the source of record: what
  verification cites, what the drawer shows, what re-processing would re-extract
  from. Raw HTML is **not** retained by default, because it is bulky, full of
  tracking noise, and the live page is one click away. Opting in stores the
  *sanitised* HTML in the encrypted bucket, covered by the deletion cascade either way.
- **Temporal honesty.** The **fetch time is the anchor**. The source reader passes
  `fetched_at` as the source timestamp, so extraction's reference time and every
  resolved interval anchor to when Cogeto read the page, which is exactly what a web
  claim can honestly assert. A newer fetch of changed content supersedes the older
  claim and closes its interval.
- **Deletion** needs no saga change: the web source implements the existing
  `SourceDeletion` port and hands the optional HTML object to the same receipt.

**Budgets before model spend.** Per-user daily caps on searches (40) and fetched
pages (100), plus a per-run page cap (5). The caps sit *before* the fetch, so they
bound outbound traffic and pipeline model work alike, and the per-user model budget
applies on top. Mid-capture exhaustion annotates the remaining URLs rather than
failing the request.

## Focused extraction, and why it exists

A 60k-character page once produced roughly 11 chunks, up to 100 facts, and one
verification call per fact: 150 to 250 sequential model calls in a single job
transaction, restarted from zero by any mid-flight failure.

Three rulings fixed it:

1. **The machine reduces before the model reads.** At capture the page is split with
   the same chunker extraction uses, chunks are ranked against `sent_query` by
   **embeddings only** (one batched call, no completions), and the top 6 in document
   order are stored as the extraction view. The complete text stays as the source of
   record. Pages under 7 chunks, query-less captures, and any focus failure extract
   whole: focusing is an optimisation, never a gate.
2. **Web sources have a fact budget** of 30, against the 100 that still stands for
   first-person sources. A fetched page is reference material; it contributes salient
   facts, not a hundred rows of page noise.
3. **Verification batches**, 10 claims per structured call, with the rubric verbatim
   and only the envelope changed: every claim is still judged independently against
   its own evidence, and a claim the reply omits is treated as unsupported, so it
   admits as `uncertain`. Single-fact sources are untouched.

Net effect: a big page drops from 150 to 250 calls to roughly 15 to 20.

## The answer cannot be lost

`research_run` has a terminal success state, `concluded`. Inside the same idempotency
transaction that processes a page's pipeline job, the worker checks whether every
captured page has settled (done or dead-lettered, so a permanently failed page cannot
hold the answer hostage) and enqueues the conclusion job. That job synthesises and
**stores** the answer on the run row whether or not anyone is watching. Only
`approved` concludes and `concluded` is terminal, so it is idempotent by construction.

A run proposed from chat records its conversation, and on conclusion the answer is
appended to that conversation as a **persistent assistant message**: memory markers
become canonical citation chips, page markers become numbered references over a
Sources block carrying title, URL, and fetch date. No buttons, no "Done", no user
action. An answer that lived only in a dismissible card was effectively lost.

The inline card therefore shows progress only and never sends anything on your
behalf: search, sources read, extraction progress, then the thread refreshes with
the appended message and the card closes itself. Chat resume picks up only approved
runs still in flight; concluded runs never resume, because their answer is already in
the thread.

Synthesis in the worker runs without retrieval, so stored answers cite pages only;
interactive synthesis also cites memories.
