# connectors: the connector platform

**V2.5 item 8.1.** What every external connector inherits: lifecycle,
credential handling (the table is `identity`'s, deliberately), cursor and
sync state, natural-key deduplication, bounded backfill, the webhook ingress
framework, outbound rate limiting, admission defaults, and capabilities
reporting. No external service is integrated here; a real connector is its
own module registering a `ConnectorDescriptor` through the composition roots
(item 8.2). The binding decision record, frozen before the code:
[`docs/features/connectors.md`](../../../docs/features/connectors.md). The
authoring guide for a new connector:
[`docs/features/connector-authoring.md`](../../../docs/features/connector-authoring.md).

Owns tables `connector`, `connector_sub_scope`, `connector_item`,
`connector_sync_run`, `connector_webhook_delivery`, `connector_rate_limit`
(migration 0054); job types `connector.sync` (plain, re-runnable,
single-flight per connector, the `import.advance` shape),
`connector.webhook_process` (idempotent per delivery) and
`connector_maintenance` (recurring); token `CONNECTORS_OPTIONS`.

Three confinement properties are enforced structurally rather than by
convention: the sealed webhook signing secret is named only in
`persistence/connector-store.ts` (`webhook-secret-confinement.spec.ts`), the
identity credential opener is worker-only
(`identity/credential-confinement.spec.ts`), and the natural-key ledger
carries identifiers and arithmetic only, never content, which is what lets
it survive source deletion as dedup state (`connector-item-cascade.ts`).

Allowed dependencies: `infrastructure`, the seams, `files` (the ONE upload
path, worker side), `ingestion` (revision recording), `memory` (the cascade
port type). The reference connector used to validate the platform lives in
`testing/reference-connector.ts` and registers only in test harnesses.
