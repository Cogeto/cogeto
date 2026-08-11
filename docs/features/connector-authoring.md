# Writing a connector

**The guide a future connector follows (V2.5 item 8.1). The binding rules are
in the decision record, [`connectors.md`](connectors.md); this is the
practical path from an upstream API to a shipped connector.** Every connector
is validated against the reference harness
(`project/src/connectors/connector-platform.integration.spec.ts`) before it
ships, and item 8.2 makes each real connector its own unit of work with its
own eval cases.

## What you implement, and what you get for free

You implement ONE object, a `ConnectorDescriptor`
(`project/src/connectors/connector-descriptor.ts`), plus the source-type
registration your sources need. You get, without writing any of it: the
lifecycle and its API, credential storage and the refresh loop, cursor
persistence and resume, natural-key deduplication and content-hash skip,
revision linking on upstream edits, bounded backfill, the webhook ingress
endpoint with verification and replay protection, outbound rate limiting
with Retry-After handling, admission bounds, budget attribution, sync
summaries, the capabilities entry, and complete removal semantics.

## Step by step

1. **Create your module** (for example `project/src/google-drive/`),
   following `project/src/README.md`: an `index.ts` barrel, a `README.md`,
   your directory added to `DOMAIN_MODULES` in `.dependency-cruiser.cjs`.
   Your module owns any tables it needs for its own bookkeeping; most
   connectors need none, because the platform's tables carry the sync state.

2. **Register a source type** if your content does not fit an existing one.
   Byte-backed documents can materialize as ordinary `file` sources through
   the platform (nothing to register). A message-shaped connector registers
   its own type: one entry in `project/shared/src/source-types.ts`, a
   `SourceReader` and a `SourceDeletion` adapter in your module, and the
   composition-root bindings. No migration, and no edit inside `memory`
   (spec 15.3). Set `userAuthored` honestly: the first-person rule depends
   on it, and the registry refuses an `observed` connector riding an
   `always` source type.

3. **Write the descriptor.** The contract, field by field, is documented in
   `connector-descriptor.ts`. The parts that deserve care:
   - **Prefer lazy content with an upstream version marker.** Where the
     upstream carries an incrementing version (Confluence pages) or a stable
     etag, set `contentHash` from it in the LISTING and make `content` a
     resolver: the ledger then skips an unchanged item before any bytes
     exist, which is the zero-cost property at its strongest. The resolver
     may return `'restricted'` or `null`; set `upstreamRevision` so a
     superseding edit's `source_revision` basis names the version.
   - **Record provenance through `annotate`**, your own table, written with
     the executor the platform hands you; failures are logged and never
     fail the sync. The confluence module's `confluence_page` is the
     precedent, deletion cascade included.
   - **Declare `listKeys` where the upstream can list identifiers**, so the
     presence sweep can reconcile what polling by modified date cannot see:
     deletions, archivals and permission losses. Mark archived items where
     the upstream distinguishes them.
   - **Declare `acceptSubScopeKey`** if users should be able to narrow to a
     container discovery cannot enumerate (a subtree); validation of the
     key against the upstream happens on the next sync, not at creation.
   - `naturalKey` must be container-independent: the same item in two
     sub-scopes must yield the same key, because the key is what makes it
     ONE source.
   - `fetchPage` treats the cursor as opaque and returns `done` honestly.
     The platform persists the cursor after every processed page; your
     paging must tolerate a page being re-fetched (the ledger absorbs
     re-listed items).
   - Map `visibility` structurally (spec 4.4.4): team-readable is `team`,
     personal is `personal`, restricted-to-a-subset is `restricted` and the
     platform will skip and report it. Never guess from content.
   - Throw `UpstreamRateLimitError(retryAfterSeconds)` on 429 and
     `UpstreamAuthError` on 401/revocation. The platform turns the first
     into a reschedule beyond the wall and the second into `needs_reauth`;
     anything else degrades the connector with a reason.
   - `refresh` is required for `auth: 'oauth2'`. It is called ahead of
     expiry by the sync engine and the maintenance pass; a throw parks the
     connector in `needs_reauth`, never a retry loop.
   - `webhook` is optional. Declare the provider's signature scheme; the
     platform verifies over the raw bytes before parsing anything. Your
     `parseEvent` extracts identifiers ONLY: payloads are signals, never
     content, and the processor re-fetches the item through `fetchItem`.
     Declare `renew` where subscriptions expire; a failed renewal degrades
     to polling visibly, never a silent stop.
   - `rate` states the upstream's politeness budget. When in doubt, be
     conservative; the default is 10 burst, 1 per second.

4. **Register it** in both composition roots:
   `ConnectorsModule.register({ connectors: [yourDescriptor] })` in the app
   root and `.forWorker({ connectors: [yourDescriptor] })` in the worker
   root. The registry validates the descriptor at boot: unregistered source
   type, missing refresh on oauth2, missing discovery with sub-scopes, and
   inconsistent authorship all refuse loudly.

5. **Validate against the harness.** Instantiate the platform exactly as
   `connector-platform.integration.spec.ts` does, with your descriptor in
   place of the reference one where the scenario applies, and prove at
   minimum: an interrupted and resumed sync re-extracts nothing; a full
   re-sync over unchanged upstream data costs zero model calls; an upstream
   edit becomes a revision, not a duplicate; removal destroys credentials
   and leaves sources intact. Then add your own upstream's quirks as new
   scenarios; the fake upstream (`testing/reference-connector.ts`) is meant
   to grow.

6. **Evals.** A real connector ships with its own golden cases (item 8.2):
   observed content at volume is exactly what the extraction gate and the
   admission caps exist for, and the numbers get published like every other
   configuration.

## What a connector may never do

Restated from the decision record because reviewers will check: no own HTTP
ingress, no own secret storage or logging of secrets, no model calls, no
cross-module table access, no unbounded backfill, no deletion of memory.
The confinement specs and the boundary checks enforce most of this
structurally; the review enforces the rest.

## The pieces you will read anyway

- `project/src/connectors/sync-engine.ts`: how a pass runs, where the
  cursor persists, how pauses reschedule.
- `project/src/connectors/persistence/item-ledger.ts`: the dedup decision
  table, encoded once for every connector.
- `project/src/identity/persistence/connector-credential-store.ts`: what
  the credential store guarantees, and why the opener is worker-only.
- `docs/features/extraction-gate.md`: the admission control your content
  passes through, unchanged.
