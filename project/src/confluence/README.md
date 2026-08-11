# confluence

The Confluence Cloud connector (V2.5 item 8.2), the first real connector on
the 8.1 platform. Decision record: [`docs/features/confluence.md`](../../../docs/features/confluence.md);
authoring guide followed: [`docs/features/connector-authoring.md`](../../../docs/features/connector-authoring.md).

**Strictly read-only by construction**: `client.ts` holds the one request
helper and it hard-codes GET; `read-only.spec.ts` fails the build if a
mutating verb or a second HTTP call site appears in this module.

What lives here:

- `client.ts`: the GET-only Confluence Cloud client (v2 pages and spaces,
  v1 CQL search, attachment download), fetch-injectable for tests.
- `storage-format.ts`: storage-format XHTML to clean structured text;
  tables become one statement per row with column context, content-bearing
  macros contribute their inner text, everything else drops cleanly.
- `descriptor.ts`: the `ConnectorDescriptor` (spaces as sub-scopes, page
  subtrees as custom scopes, version-number change detection with LAZY
  content, presence listing, provenance annotation).
- `persistence/`: the `confluence_page` provenance table (migration 0055),
  content-bearing, erased with its source by `ConfluencePageCascade`.
- `estimate.ts` + `jobs.ts`: the worker-side backfill estimate
  (`confluence.estimate`).
- `confluence.controller.ts`: the connect flow, validating the supplied
  token with one read call BEFORE sealing it, with a specific failure
  taxonomy.

Allowed dependencies: `infrastructure`, `identity` (credential store),
`connectors` (the platform barrel), `memory` (the `DerivedCascade` type),
`@cogeto/shared`. Everything operational (lifecycle, cursors, dedup,
rate limiting, admission, budget attribution, capabilities) is inherited
from the platform and deliberately not reimplemented here.

An Atlassian API token carries its account's full permissions, so read-only
rests on this module's construction; the recommended stronger arrangement
(a dedicated read-only Atlassian account) is documented in
[`docs/security/confluence-connector.md`](../../../docs/security/confluence-connector.md).
