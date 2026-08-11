# The Confluence Cloud connector

**V2.5 item 8.2, the first external connector. The decision record, frozen
before the code. Owned by `confluence` (migration 0055 carries its table and
the platform columns this unit adds), built entirely on the connector
platform ([`connectors.md`](connectors.md)) and authored per
[`connector-authoring.md`](connector-authoring.md).**

Two constraints override everything else in this unit:

1. **Strictly read-only, structurally.** Nothing in this connector can
   create, edit or delete anything in Confluence, and that property is
   enforced by construction, not by intent: the client implements read
   operations only and an architecture assertion fails the build if a
   mutating HTTP verb appears in it.
2. **A re-sync over unchanged content costs zero model calls.** Confluence
   pages carry an incrementing version number, so an unchanged page is
   skipped before its content is fetched in full and before any model call.
   Getting this wrong would quietly cost a customer real money on every
   poll, which is why the property is a named test, not a code-review hope.

## Authentication (issue A)

Atlassian API token with Basic auth: the user supplies their site URL, their
account email and a token. All three are sealed together as one credential
in the identity seam's `connector_credential` (auth style `api_key`, no
refresh loop: Atlassian API tokens do not rotate). The site URL and email
are not secrets by themselves, but they travel with the token and nothing
outside the worker ever needs them back, so they live inside the sealed
envelope; what the user is entitled to see (the account identity, shown as
`email on site`) is stored beside it in plaintext.

**Validation happens at connect time, with the material still in hand.**
The confluence module's own connect endpoint makes one read call before
sealing anything and reports specifically what failed:

| Reported | Detected by |
|---|---|
| `wrong_site` | the site answered but it is not a Confluence Cloud API (or 404 on the API root) |
| `bad_credentials` | 401: the email and token pair is not accepted |
| `no_permission` | 403, or an empty space listing where the account can see nothing |
| `unreachable` | DNS, TLS or network failure reaching the site |

This does not violate the worker-only opener rule: the app validates what
the user just typed, before it is sealed. It never reads a sealed
credential back.

**Credential failure at sync time** is the platform lifecycle: a 401 or 403
from any read moves the connector to `needs_reauth` with an actionable
message, never a silently failing sync (`UpstreamAuthError`).

## Read-only, and what enforces it (issue A)

The client (`confluence/client.ts`) has exactly one request helper and it
hard-codes `method: 'GET'`. No create, update or delete method exists.
`read-only.spec.ts` asserts it structurally and fails the build otherwise:

- the `confluence` module contains exactly one `fetch(` call site, in the
  client;
- the client names no HTTP verb other than GET: no `POST`, `PUT`, `PATCH`
  or `DELETE` string anywhere in the module's runtime code.

**The honesty note, stated here and in `docs/security/`:** an Atlassian API
token carries the full permissions of its account. Read-only therefore
rests on Cogeto's implementation, not on a limited credential. The stronger
arrangement, recommended prominently to security-conscious customers, is a
dedicated Atlassian account granted read-only permission on the chosen
spaces, so the restriction is enforced by Confluence itself. The interface
states at the moment of connecting that Cogeto only reads and never
creates, edits or deletes.

## Scoping (issue B)

**Sub-scopes are spaces**, the unit users think in. Discovery lists the
spaces the account can see (key `space:{id}`, label `name (KEY)`); nothing
is selected by default and nothing outside the selection is ever fetched.

**Narrowing to a page and its descendants** is a custom sub-scope
(key `page:{spaceId}:{pageId}`), created through the platform's new custom
sub-scope endpoint and validated by the descriptor's key grammar. Its
listing reuses the space listing (metadata only, no bodies) and filters by
the ancestor chain from `parentId`, which keeps the client GET-only and
one-code-path; the page tree is metadata, and listing it is cheap next to
fetching one body.

**Backfill is the platform's**: default 30 days and 500 items per
sub-scope, widened or set to "everything" only by explicit choice. The
honest estimate comes from the `confluence.estimate` job (worker-side,
because counting needs the credential): a CQL count per selected scope for
the chosen window, written to the sub-scope's stats and shown before
anything runs.

**Per-space policy runs through the extraction gate.** This unit activates
the gate's reserved `folder` dimension: the sub-scope key is stamped on the
materialized object and travels to the gate chokepoint, so a rule keyed
`folder = space:123` can disable extraction for one space, and a rule row
can carry its own fact budget and retention (tightest-of still wins).
Whether attachments are pulled is a per-sub-scope setting, enforced before
fetch, which is cheaper than any gate. Confluence content is authored by
colleagues: the descriptor declares `authorship: 'observed'`, its sources
are `file` (`userAuthored: 'never'`), and the first-person rule holds
structurally; a test asserts it.

**Changing scope later**: adding a space backfills it (fresh cursor, same
bounds); deselecting a space stops fetching it and leaves every ingested
source intact, the platform's removal rule applied to one scope.

## Sync, versions, deduplication (issue C)

**Natural keys**: `conf:page:{pageId}` and `conf:att:{attachmentId}`.
Page ids are stable across renames and moves, so a renamed page updates
rather than duplicating; uniqueness is the platform's
`(connector_id, natural_key)` constraint.

**Change detection is the version number.** The listing is fetched without
bodies; `contentHash = sha256("page:{id}:v{version}")` (attachments alike).
The ledger skips an unchanged item on hash equality, so an unchanged page
costs one line in a listing page and nothing else. **Content is lazy**: the
platform's `UpstreamItem.content` may be a resolver, called only when the
ledger decided to materialize, so a full re-sync over unchanged content
fetches zero bodies and performs zero extractions. The named test proves
both counts.

**A version increase is a revision.** The platform materializes the new
content and records the automatic `source_revision` link
(`upstreamIdentity` = the natural key, `revisionNew` = the Confluence
version number, carried by the new `upstreamRevision` field). Fact-level
behaviour is the existing reconciliation: the edit supersedes, and a
contradiction resolved by the edit moves through the 6.1 findings
lifecycle with the revision recorded as the cause.

**Incremental discovery** lists by `-modified-date` and stops at the stored
watermark; the cursor (`{watermark, next}`) is persisted by the platform
after every processed page, so an interrupted sync resumes rather than
restarts, and the ledger absorbs anything re-listed.

**Disappeared, archived, moved, permission-changed**, decided deliberately:

| Case | Detection | Decision |
|---|---|---|
| Deleted upstream | absent from a presence sweep; a targeted fetch 404s | The ledger marks `deleted_upstream`, reason `absent`; the source remains and the Sources view says so. Deletion is the user's act, never the connector's. |
| Archived | the presence sweep lists archived page ids separately (`status=archived`) | Marked `deleted_upstream` with reason `archived`: distinguishable from deletion in the surface, equally never auto-deleted. A restored page reactivates the ledger row. |
| Moved between spaces | the natural key is container-independent | The platform's `moved` path: same source, sub-scope observed updated; a move out of every selected scope makes the page absent, which the sweep then reports as such. |
| Permission changed | the account stops seeing the page | Indistinguishable from deletion through this API with this account, and the record says so honestly: marked `absent`. A page still visible but carrying view restrictions is skipped as `restricted` at materialization time (spec 4.4.4) and reported. |

The **presence sweep** is a platform addition shaped for every polling
connector, because incremental listing by modified date structurally cannot
observe an absence: the descriptor's `listKeys` pages through current (and
archived) identifiers only, and the platform reconciles the ledger against
the observed set, restoring reappeared items and marking the rest. It runs
on the maintenance schedule (default every 7 days) and on demand, under the
same per-connector single-flight lock as sync.

**No webhooks.** Confluence Cloud webhooks require a Connect or Forge app;
an API token cannot register one. The descriptor declares no webhook
scheme, polling is the loop, and the sweep covers what polling cannot see.

## Content, attachments, provenance (issue D)

**Storage format to clean text.** Confluence pages arrive as storage format
(XHTML). A dependency-free converter (`confluence/storage-format.ts`)
produces structured plain text: headings and list items become their own
lines, paragraphs stay paragraphs, and **tables become one statement per
row with the column context repeated**, the spreadsheet convention, because
specifications live in tables and a naked row extracts as nothing or as an
invention. Macros carrying readable content (code, panels, expand blocks,
quotes) contribute their inner text; everything else (Jira gadgets, TOC,
include and view-file widgets, layout chrome) is dropped cleanly, and an
unresolvable macro produces no fabricated text, per the fabrication rule.

The converted text is uploaded through the ONE existing path as
`text/markdown`, read by the new registered plain-text reader
(`files/reading/text.reader.ts`, paragraph locators, `detectable: false`
exactly like CSV because text has no magic bytes). A fact's span therefore
locates to a paragraph of the converted page, which the drawer renders.

**Provenance** is the confluence-owned `confluence_page` row per
materialized source: page id, title, space key and name, version, the live
page URL, and the parent page where there is one. Content-bearing (titles
are the document's own words), so it joins the deletion cascade, erased
with its source. The Sources view shows space, title and version and links
back to the live page; a fact's citation reaches the same drawer. The
platform's new `annotate` hook writes the row at materialization, with
failures logged and never failing the sync.

**Attachments are opt-in per space.** When enabled, each page's attachments
of a type the reading layer accepts (PDF, DOCX, XLSX, CSV, images) become
their own items, lazily downloaded, materialized as ordinary file sources
through the same reader tiers (OCR and vision ladder included), linked to
their page by the provenance row. Unsupported attachment types are not
fetched at all. Attachment versions dedup exactly as pages do.

**Hierarchy is the anchoring signal.** The upload filename is the page's
own breadcrumb, `Space / Parent / Title.md` (capped at the nearest two
ancestors), which is precisely what the anchor stage already consumes as
FILENAME. A page deep under a product area therefore anchors toward that
subject with the existing confident-or-uncertain judgment; nothing asserts
more than is known, no anchor input format changed, and the eval cache is
untouched.

## Operational behaviour (issue E)

- **Polling**: the platform maintenance loop enqueues due syncs (15-minute
  cadence); a manual "sync now" action exists. The rate profile is
  conservative (burst 10, 2 requests per second refill) and every 429's
  `Retry-After` becomes a wall the whole pass reschedules beyond, the
  platform's E1 behaviour, proven against the fake upstream.
- **Health**: the platform's `connectors` capability entry carries the
  fleet state (connected, syncing, healthy with last sync, degraded with
  reason, needs reauthorisation); the Settings surface shows per-connector
  state, last sync, paused reason and recent runs. A connector that
  silently stopped syncing is visible as `degraded` or `needs_reauth`,
  never merely quiet.
- **Sources view**: a Confluence-sourced document shows its space, title,
  version and a link to the live page, one click from fact to original.
- **Budget attribution**: every job carries the owner's principal, so
  sync-driven ingestion meters against the owning user exactly as
  interactive work does (platform, already proven).

## What this unit adds to the platform (owned by `connectors`)

Each is additive and shaped for every future connector, not for one vendor:

| Addition | Why |
|---|---|
| Lazy `UpstreamItem.content` (resolver variant, plus `meta` and `upstreamRevision`) | the zero-cost property requires skipping before bodies are fetched; the revision number belongs on the `source_revision` basis |
| `annotate` descriptor hook | a connector records its own provenance for a materialized source without touching the engine |
| Custom sub-scopes (`POST /:id/sub-scopes`, descriptor key grammar) | narrowing to a container discovery cannot enumerate (a page tree) |
| Sub-scope `settingsJson` and `statsJson` | the per-scope attachments toggle; the honest backfill estimate |
| Presence sweep (`listKeys` hook, `connector.presence_sweep`, ledger reconcile) | polling by modified date cannot observe absence |
| Rule-level gate budget and retention, `folder` dimension enforced | per-space policy through the gate, as 8.1 reserved |

## Module bookkeeping

`confluence/` is a domain module. It owns the `confluence_page` table, the
`confluence.estimate` job type, and its API surface
(`/api/confluence/...`). Its descriptor registers in both composition
roots; `sources` reads its provenance through the barrel, matching how the
catalog already reads every family. The `file` source type is reused, so
no reader or deletion port is added; the provenance row's cascade adapter
is registered beside the connector item cascade.
