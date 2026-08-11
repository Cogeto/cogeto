/**
 * Job-type contracts owned by the connectors platform (V2.5 item 8.1;
 * boundary contract section 3: one declaration, enqueue through the
 * constant, the handler is the owner's).
 */

/**
 * One bounded sync pass for one connector: a PLAIN, re-runnable task (the
 * `import.advance` shape) under a per-connector single-flight lock. A pass
 * fetches at most a few pages, persists the cursor after each, and
 * re-enqueues itself; pauses (rate wall, daily cap, budget) reschedule
 * visibly rather than bypassing anything.
 */
export const CONNECTOR_SYNC_JOB_TYPE = 'connector.sync';

/**
 * Process one verified webhook delivery: an idempotent per-source task
 * (`source_type: 'connector_webhook'`, `source_id`: the delivery row id).
 * The payload was only a signal; the handler re-fetches the named items
 * from the upstream through the normal outbound path.
 */
export const CONNECTOR_WEBHOOK_JOB_TYPE = 'connector.webhook_process';

/**
 * The recurring pass: refresh credentials ahead of expiry, renew webhook
 * subscriptions ahead of theirs (degrading to polling when renewal fails,
 * never silently stopping), prune the delivery ledger, and enqueue the
 * periodic incremental sync for every active connector, which IS the polling
 * fallback.
 */
export const CONNECTOR_MAINTENANCE_JOB_TYPE = 'connector_maintenance';
export const CONNECTOR_MAINTENANCE_CRONTAB = '*/15 * * * * connector_maintenance';

/**
 * Connector ingestion is background work: its pipeline jobs run at the
 * bulk-import demotion so any interactive capture jumps ahead (numerically
 * smaller priority runs first; interactive default is 0).
 */
export const CONNECTOR_PIPELINE_PRIORITY = 100;

/** Webhook delivery ledger retention; rows carry identifiers only. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
