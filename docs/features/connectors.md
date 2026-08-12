# The connector platform: what every external connector inherits

**V2.5 item 8.1. The decision record, frozen before the code. Owned by
`connectors` (the platform module; migration 0054), with credential storage
owned by `identity`.**

No external service is integrated by this unit, deliberately: a platform
shaped around one vendor's quirks is not a platform. What ships here is the
foundation every future connector inherits, proved against a reference
connector that exists only in tests. The first real connector follows
separately, chosen by partner demand (item 8.2).

## The stance

Five rules govern everything below, each inherited from a decision this
project already made:

1. **Ingestion cost is the failure mode.** A polling connector that re-returns
   the same thousand items must cost zero model calls the second time. Every
   design choice below is shaped by the fact that extraction is the expensive
   step and the natural-key ledger is what stands in front of it.
2. **Deleting a connector must not silently erase memory.** Sources ingested
   through a connector are the user's verified memory, with provenance intact.
   Removal destroys credentials and sync state; it never touches sources.
   The user deletes sources through the deletion saga, or not at all.
3. **A connector's content is somebody's words, and the platform must know
   whose.** The first-person rule (spec 3.8, 3.9) and the extraction gate both
   depend on whether content is authored by the user or merely observed, so
   authorship is a declared property of the connector, never a model judgment.
4. **The app process holds no upstream credentials it can read.** The worker
   syncs; the app configures. Credential material can be written and destroyed
   from the request path but opened only in the worker, the
   `MemorySystemStore` withholding pattern applied to secrets.
5. **Nothing regresses.** Notes, files, chat, email and web research keep
   working exactly as they do today. The platform is additive; the section
   "What migrated and what did not" records the decision per family.

## What a connector is

A connector is an adapter for one external system, declared as a
**`ConnectorDescriptor`** and registered with the platform through the
composition roots (`ConnectorsModule.register({ connectors })`). Adding a
connector touches its own module and the registration only: no migration
anywhere, and no edit inside `memory`, the source-type registry's guarantee
(spec 15.3, `docs/module-boundary-contract.md` section 6).

### What a connector declares

| Declaration | Meaning |
|---|---|
| `kind` | The registry key (for example `google_drive`). Unique, stable, never renamed. |
| `sourceType` | The registered source-type key its materialized sources carry. The connector's own module registers the type with its reader and deletion ports, exactly as every family does today. |
| `auth` | The authentication style: `oauth2` (access plus refresh token, expiry, scopes), `api_key`, or `none`. Determines what the credential store holds and whether the refresh loop runs. |
| `discovery` | `listSubScopes(secrets)`: what containers exist upstream (mailboxes, channels, folders, projects, spaces). Offered to the user for selection; never auto-selected. |
| `fetch` | `fetchPage(secrets, subScope, cursor, limits)`: one bounded page of items plus the next cursor. The platform owns when and how often this is called. |
| `fetchItem` | `fetchItem(secrets, ref)`: one targeted item, used by webhook-triggered sync. |
| `naturalKey` | How an item's upstream identifier is derived. Container-independent by contract: the same item in two sub-scopes must yield the same key. |
| `subScopes` | The sub-scope vocabulary: what a sub-scope is called and whether the connector has them at all. |
| `authorship` | `authored` (the user's own words, for example their sent messages) or `observed` (third-party content). Maps onto the source-type registry's `userAuthored` contract; a `per_item` source type may refine it per item, the email precedent. |
| `scopeOf` | How an upstream item's visibility maps to Cogeto scope (spec 4.4.4): team-readable maps to `shared`, personal maps to `private`, restricted-to-a-subset is **skipped and reported** in the sync summary. Structural, never a model judgment. |
| `webhook` | Optional: the provider's signature scheme (HMAC algorithm, signature and timestamp headers, tolerance), how the event id and item reference are extracted, and the subscription renewal call where subscriptions expire. |
| `rate` | The token-bucket profile for upstream calls: capacity and refill per connector and per account. |

### What the platform provides

Lifecycle and state, credential storage and the refresh loop, cursor
persistence and resume, natural-key deduplication and content-hash skip,
revision linking on upstream edits, bounded backfill, the webhook ingress
endpoint with verification and replay protection and delivery deduplication,
outbound rate limiting with `Retry-After` handling, admission defaults and
budget attribution, capabilities reporting, sync run summaries, and complete
removal. A connector implements fetching and mapping; everything operational
is inherited.

### What a connector may never do

- Open its own HTTP ingress. Webhooks arrive only through the platform's
  endpoint, behind the platform's verification.
- Store or log a secret. Credential material lives in the identity seam's
  sealed store; webhook signing secrets in the platform's sealed column.
- Call a model. Content reaches models only by becoming a source and passing
  through the ingestion pipeline, behind the extraction gate and the fences.
- Touch another module's tables, enqueue by string literal, or bypass the one
  upload path for byte-backed sources. The boundary contract applies to a
  connector like any module.
- Begin an unbounded backfill, on connection or ever. Backfill bounds are the
  user's explicit choice.
- Delete memory. Upstream deletions mark the item ledger; sources remain.

## Lifecycle

One state column on the connector row, transitions owned by a pure domain
state machine (`connectors/domain/lifecycle.ts`), every transition audited
with structural detail only:

| State | Meaning |
|---|---|
| `configured` | Created, not yet authorised. Nothing fetched. |
| `authorised` | Credentials stored and verified; sub-scopes discoverable; no sync confirmed yet. |
| `syncing` | A backfill or incremental sync is actively running. |
| `healthy` | Last sync completed; incremental sync is the steady state. |
| `degraded` | Syncs are failing or the webhook subscription lapsed and polling took over. Actionable message required. |
| `needs_reauth` | Refresh failed, or the upstream revoked access. The refresh loop never retries forever into this state; the user reconnects. |
| `disabled` | The user paused it. Credentials kept, nothing fetched. |
| `removed` | Terminal. See removal semantics. |

**Removal is complete, and it is stated plainly: already-ingested sources
remain as sources with their provenance intact unless the user deletes them,
because deleting a connector must not silently erase memory.** What removal
destroys, in one transaction plus the audited credential destruction:
credentials (immediately and verifiably, the audit row recording that
destruction happened without recording any secret), every cursor, every
sub-scope row, pending webhook deliveries, and rate state. The connector row
itself is kept as a tombstone with its user-chosen name cleared (the
`import_item` precedent: names are content, arithmetic is not), because the
item ledger anchors to it. The item ledger survives as deduplication
arithmetic, so reconnecting the same upstream later does not re-ingest what
the corpus already holds.

## The natural-key ledger and deduplication (the financially consequential part)

Nothing in Cogeto today enforces remote-id uniqueness; the platform does.
Every item a connector returns is recorded in `connector_item`, and a
uniqueness constraint on **`(connector_id, natural_key)`** makes "the same
item became two sources" unrepresentable.

`connector_item` carries **identifiers and arithmetic only, never content**:
the natural key, the content hash, the materialized source reference, states
and timestamps. No titles, no names, no excerpts. That is what lets the
ledger survive source deletion as dedup arithmetic without joining the
content-bearing cascade.

The decision table, encoded in the platform's sync engine rather than left to
each connector:

| Upstream case | Detection | Behaviour |
|---|---|---|
| Unchanged item reappears (poll, replay, full re-list) | natural key known, content hash equal | **Skip before any model call.** Touch `last_seen_at`. This is the property the harness proves: a full re-sync over unchanged upstream data costs zero model calls. |
| Item edited upstream (identifier stable, content changed) | natural key known, content hash differs | **New source as a revision.** Materialize the new content as a new source, record a `source_revision` link (`auto`, high confidence, basis naming the upstream identity), and point the ledger at the new tip. The upstream's own statement "same item, new content" is stronger evidence than the filename match bulk import corroborates from, so it earns the automatic link; fact-level behaviour is the existing reconciliation machinery, per `revisions.md`, and an edited item supersedes rather than contradicting itself. |
| Item moved between containers | natural key known, sub-scope differs | **Same source.** The key is container-independent by contract. The observed sub-scope is updated; if the move changes the scope mapping (a private item now team-readable), the platform does **not** silently re-stamp scope: the change is reported in the sync summary for the user to act on, because scope moves are consequential and spec 4.6 makes them explicit, audited edits. |
| Item legitimately in two sub-scopes | same natural key from two selected sub-scopes | **One source.** Both sub-scopes are recorded as having seen it; neither creates a second source. |
| Item deleted upstream | absent from a full pass, or a webhook deletion event | **The source remains.** The ledger marks `deleted_upstream`; memory is the user's, and an upstream deletion is a fact about the upstream, not an instruction to erase verified memory. The sync summary reports it. |
| The user erased the ingested source | deletion saga cascade | The ledger row is marked `erased` and its source reference cleared (a dangling provenance reference may not outlive a receipt). **An erased item is never re-materialized by a later sync**: the user's deletion stands even though the upstream still has the item. |

Content-hash comparison runs beside the key on every pass, so the skip
decision never needs a fetch of anything beyond what the listing already
returned, and an unchanged item costs nothing downstream.

## Cursors, sync state and backfill

Cursor and delta state is stored per connector and per sub-scope, as whatever
opaque token, timestamp or sequence the upstream provides. A sync resumes
from its cursor; it never restarts from zero, because a restarted sync that
re-fetches everything is not merely slow, it is expensive at full model cost.
The cursor is persisted after every page, inside the same pass that processed
the page, so an interruption loses at most one page of listing work and zero
extraction work (the ledger absorbs re-listed items).

The sync engine is the `import.advance` shape, deliberately: a plain,
re-runnable `connector.sync` job under a per-connector single-flight lock,
advancing one bounded slice per pass and re-enqueueing itself; a paused
condition (budget exhausted, rate limited, cap reached) reschedules visibly
rather than bypassing anything. Materialization enters the ONE existing
upload path at demoted queue priority, the bulk-import posture, so a busy
connector cannot starve interactive work.

**Backfill is bounded by explicit choice, never silently unbounded.** A newly
connected source has history, and pulling all of it can be enormous. The
defaults, stated so they can be argued with:

- Default initial backfill: the last **30 days**, capped at **500 items per
  sub-scope**, over the sub-scopes the user selected.
- The user may widen either bound, choose a different window, or explicitly
  choose "everything", which is a stated choice with the item estimate shown
  where the upstream can provide one, never a default.
- After backfill, incremental sync from the cursor is the steady state.

## Credential storage (inside the identity seam)

The plan places credential storage inside the identity seam, and the
established master-key pattern is reused rather than a second secret
mechanism being invented: the AES-256-GCM sealed-secret primitive moves from
`providers/domain/secret-box.ts` to `infrastructure/secret-box.ts` (a leaf
both the seam and domain modules may import), byte-identical, and `providers`
keeps consuming it unchanged. `COGETO_MASTER_KEY` stays in the environment,
because a key that guards a database cannot live inside it.

`connector_credential`, owned by `identity`: the sealed secret material
(access token, refresh token, and any provider extras, sealed as one JSON
envelope in a single column), and beside it in plaintext what the user is
entitled to see: expiry, the scopes granted, and the account identity the
credential belongs to.

The confinement rules, each enforced structurally in the
`key-confinement.spec.ts` shape:

- The sealed column is selected in exactly one function, in identity's
  credential store.
- **Opening is a worker-only capability.** `IdentityModule.register({
  credentialReads: true })` is passed by the worker root alone; the app root's
  injector cannot resolve the opener, so a request-path service that asked
  for it fails at boot. The app can store, describe (metadata only) and
  destroy credentials; it can never read one back.
- Credentials are never returned by any endpoint, never logged, never in an
  export, never rendered after entry. The scopes granted are shown, because a
  user should see what access they gave.

**The refresh loop is first-class.** The recurring `connector_maintenance`
job refreshes credentials before expiry; the sync engine refreshes at sync
start when the token is within its refresh window. A refresh failure moves
the connector to `needs_reauth` and stops, rather than retrying forever, and
**an expired or revoked credential is never allowed to look like "the source
had nothing new"**: a sync that cannot authenticate is a failed sync with a
named reason, visible in capabilities, never an empty success. Revocation
from the provider's side (a 401 mid-sync) is handled the same way.

Webhook signing secrets are deliberately **not** identity credentials: the
app-side ingress endpoint must verify signatures, and the identity opener is
worker-only. They are sealed with the same secret-box into the platform's own
column, with their own confinement spec. One mechanism, two owners, each
column opened in exactly one place.

## Webhook ingress (hostile-facing by nature)

One shared framework, one public endpoint
(`POST /api/connectors/webhooks/:connectorId`), no per-connector hand-rolls:

1. **Reject before parsing.** The raw body is size-capped at the transport
   (the email-intake `express.raw` precedent). Signature verification runs
   over the raw bytes with the descriptor's declared scheme before anything
   is parsed; unsigned or badly signed payloads are refused with no parse
   work. Timestamp tolerance refuses replayed and stale deliveries.
2. **Delivery deduplication by event identifier.** A unique
   `(connector_id, event_id)` insert; a duplicate delivery acknowledges 200
   and does nothing, so upstream retries are harmless.
3. **Receipt enqueues work.** The endpoint records the delivery, enqueues
   `connector.webhook_process` transactionally, and acknowledges fast. A slow
   ingestion can never cause upstream retry storms.
4. **Payloads are signals, never content.** The framework extracts the event
   id, the item reference and the sub-scope from the verified payload and
   stores only those. The processor fetches the item from the upstream
   through the normal outbound path (rate limited, credentialed, worker-side)
   and hands it to the same dedup and materialization the poll uses. Webhook
   content therefore never reaches a model at all; what reaches the model is
   fetched content on the ordinary pipeline path, behind the same fences and
   guards documents and mail already receive. Ordering follows from
   idempotence: processing is a targeted fetch of current upstream state, so
   out-of-order deliveries converge on the same result.
5. **Per-source rate limiting** on the endpoint via the durable
   `RateLimitStore`, the email-intake precedent.
6. **Renewal and fallback.** Subscription expiry is tracked; the maintenance
   job renews ahead of time. A lapsed subscription **degrades the connector
   to polling** and marks it `degraded` with an actionable message; it never
   silently stops.

## Outbound rate limiting and admission

**Rate limiting is new behaviour, not configuration.** The existing job retry
mechanism is not rate aware, and the research fetcher deliberately skips on
429. For connectors: a token bucket per connector and per account, from the
descriptor's declared profile, with durable spill state; a 429 or
`Retry-After` records the wall clock the upstream named, and the sync pass
reschedules itself beyond it rather than retrying into the same wall. Backoff
composes with the bucket: the next attempt waits for the later of refill and
`Retry-After`. Because a connector instance holds exactly one account
credential in this unit, the per-connector bucket IS the per-account bucket;
the `connector_rate_limit` bucket key is text precisely so a future
multi-account connector adds account buckets without a migration. The wall
gates the whole pass, discovery included: a pass inside it touches the
upstream zero times.

**Admission inherits from the extraction gate**, which was built for exactly
this day. Every materialized source passes the gate chokepoint per owner and
source kind, unchanged. On top of it the platform adds the item-level bound
the gate cannot see, stated per authorship class:

- **Observed connectors default to bounded extraction: 200 items per
  connector per day.** A busy channel or shared drive can produce more
  content in a day than a professional writes in a year, and the default must
  survive that.
- **Authored connectors default to 1000 items per connector per day**, a
  ceiling against runaway upstreams rather than a working limit.
- Both are configurable per connector and per sub-scope; exhaustion pauses
  the sync visibly (the import posture), never bypasses, never drops.

**Sub-scope selection is the user's control surface**, provided uniformly by
the platform in the email-allowlist shape users already understand: discovery
offers what exists, the user selects, nothing outside the selection is ever
fetched. Selection is enforced before fetch, which is cheaper than any gate:
an unselected mailbox costs zero requests, zero reads, zero model calls. The
gate's reserved `channel` and `folder` dimensions stay reserved in this unit:
the platform's selection surface subsumes their job for connectors, and a
gate dimension nothing enforces would be a control that silently does not
control.

**Budget attribution:** every job the platform enqueues carries the owning
user's principal, so connector-driven ingestion is metered against the owner
exactly as interactive work is. A background sync that exhausts the owner's
daily model budget pauses and resumes later, the managed-rebuild posture.

## Capabilities

One `connectors` entry in the capability registry, fed through an
operations-owned port the connectors module implements (bound by the roots,
the `CAPABILITY_JOB_SOURCES` pattern): `off` when no connector is configured,
`on` when all configured connectors are healthy, and **loud** when any is
`degraded` or `needs_reauth`, with the actionable message naming the
connector and the fix ("reconnect it from Settings"). Per-connector state,
last sync, and sync summaries are the platform API's own surface.

## What migrated and what did not

Nothing migrated, and each reason is recorded:

| Family | Decision | Reason |
|---|---|---|
| email | left as is | Its intake is push (Haraka relays SMTP with an internal bearer contract and SMTP verdict semantics), not a signed provider webhook; its allowlist, refusal ledger and SPF gating are hardened, audited machinery. Forcing it under the webhook framework would change the Haraka contract to prove a point about abstraction, the exact bad trade the constraint names. |
| files, notes, chat | left as is | User-driven capture with no upstream, no credentials, no cursors, no webhooks. There is nothing for the platform to provide them. |
| web research | left as is | Its outbound posture (skip on failure, never retry, per-run approval) is deliberate and documented; adopting the token bucket would change measured behaviour for no current need. Recorded as a candidate adopter when research revisits fetch behaviour. |

The platform is for external pull-and-webhook connectors, which none of the
five is. Existing behaviour is byte-identical.

## What the first real connector added (V2.5 item 8.2)

The Confluence connector ([`confluence.md`](confluence.md)) shook out six
additive platform extensions, each shaped for every future connector:

- **Lazy content.** `UpstreamItem.content` may be a resolver, called only
  when the ledger decided to materialize, so an unchanged item never fetches
  its body; `contentHash` is then required (the upstream's version marker,
  hashed). The resolver may answer `'restricted'` (skipped and reported) or
  `null` (gone upstream), and a rate-limit throw pauses the pass beyond the
  wall. `upstreamRevision` carries the upstream's version number onto the
  automatic `source_revision` basis, so a finding resolved by an edit can
  name the version that resolved it.
- **`annotate`.** A descriptor hook called after materialization with the
  platform's executor, the item, the source ref and the connector identity:
  the connector records its own provenance in its own table, fail-safe,
  never failing the sync.
- **Custom sub-scopes.** `POST /:id/sub-scopes` creates a scope discovery
  cannot enumerate (a page subtree), validated by the descriptor's
  `acceptSubScopeKey` grammar; upstream validation happens on the next sync.
- **Per-scope settings and stats.** `connector_sub_scope.settings_json`
  (today the attachments toggle, enforced before fetch) and `stats_json`
  (the worker-computed backfill estimate, shown before anything runs);
  `fetchPage` receives the scope's settings verbatim.
- **The presence sweep.** Polling by modified date structurally cannot
  observe an absence, so a descriptor may declare `listKeys` (identifiers
  only, paged) and the `connector.presence_sweep` job reconciles the ledger
  on the maintenance cadence and on demand: absent items are marked with the
  observed reason (`absent`, or `archived` where the upstream can say),
  reappeared items are restored, and nothing is ever deleted. A partially
  listed scope never marks anything.
- **Gate folder rules enforced.** The reserved `folder` dimension became
  real: the sub-scope key is stamped on the materialized object and carried
  to the gate chokepoint, and a rule row may carry its own fact budget and
  retention ([`extraction-gate.md`](extraction-gate.md)).

## The reference connector (tests only)

The platform is proved against a fake upstream implementing paging, cursors,
edits, deletions, duplicate webhook deliveries, expiring credentials, rate
limiting with `Retry-After`, and webhook signatures. It registers only in
test harnesses, never in a composition root, and it is a deliverable: every
future connector is validated against the same scenarios before it ships.
The two expensive-failure tests are named requirements: an interrupted and
resumed sync re-extracts nothing already ingested, and a full re-sync over
unchanged upstream data costs zero model calls.

## Tables, jobs, tokens (the boundary bookkeeping)

| Owner | Additions |
|---|---|
| `connectors` (new module) | `connector`, `connector_sub_scope`, `connector_item`, `connector_sync_run`, `connector_webhook_delivery`, `connector_rate_limit`; job types `connector.sync` (per-source, plain re-runnable, single-flight per connector), `connector.webhook_process` (per-source, idempotent), `connector_maintenance` (recurring), `connector.presence_sweep` (per-source, single-flight, V2.5 item 8.2); token `CONNECTORS_OPTIONS` |
| `identity` | `connector_credential`; registration option `credentialReads` (worker-only opener) |
| `operations` | `CONNECTOR_HEALTH` port token (implemented by `connectors`, bound by the roots) |

Deletion coverage: `ConnectorItemCascade` clears the source reference and
marks the item `erased` when its source is erased (arithmetic kept, nothing
content-bearing survives because nothing content-bearing is stored);
`connector_webhook_delivery` is pruned on retention and carries no content.
Credential destruction is audited without the secret. The
`extraction_gate_refusal` and `file_read_report` honesty rules carry over:
a gated or failed connector item never looks processed-with-zero-facts, and
a sync summary states what was skipped and why.

## A sub-scope can feed a project (V2.5 item 8.3)

A sub-scope may be assigned to a project, and then everything it ingests lands
there automatically: the natural way a client's document space becomes a
client's project. The sync engine resolves the sub-scope's project by KEY (so
the poll and the webhook paths resolve it identically) and passes it to the
upload, which records the assignment **inside the same transaction** that
creates the source. There is therefore no window in which a materialized
source exists without its project, and no repair pass to run.

Propagation happens once, at materialization. Reassigning a sub-scope moves
what it ingests NEXT and never rewrites what it already recorded, which is
stated in the interface because silently rewriting history is the surprising
behaviour. Removing a connector releases its sub-scope assignments; the
sources it already produced keep theirs, because they are still that client's
documents.
