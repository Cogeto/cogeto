/** Public interface of the connectors platform (spec §15 rule 1). */
export { ConnectorsModule, ConnectorItemCascadeModule } from './connectors.module';
export { ConnectorRegistry } from './connector-registry';
export { ConnectorSyncEngine } from './sync-engine';
export { ConnectorWebhookProcessor } from './webhook-processor';
export { ConnectorMaintenance } from './maintenance';
export { ConnectorPresenceSweep } from './presence-sweep';
export { ConnectorStore } from './persistence/connector-store';
export { ConnectorItemLedger } from './persistence/item-ledger';
export { ConnectorHealthSource } from './connector-health';
export type { ConnectorFleetSummary } from './connector-health';
export { ConnectorItemCascade } from './connector-item-cascade';
export { CONNECTORS_OPTIONS } from './connectors.options';
export type { ConnectorsOptions } from './connectors.options';
export {
  CONNECTOR_SYNC_JOB_TYPE,
  CONNECTOR_WEBHOOK_JOB_TYPE,
  CONNECTOR_MAINTENANCE_JOB_TYPE,
  CONNECTOR_MAINTENANCE_CRONTAB,
  CONNECTOR_PRESENCE_JOB_TYPE,
} from './connector-jobs';
export { UpstreamAuthError, UpstreamRateLimitError } from './connector-descriptor';
export type {
  ConnectorDescriptor,
  ConnectorSecrets,
  ConnectorWebhookScheme,
  ConnectorRateProfile,
  FetchPageArgs,
  FetchPageResult,
  LazyUpstreamContent,
  UpstreamItem,
  UpstreamItemContent,
  UpstreamItemRef,
} from './connector-descriptor';
export { CONNECTOR_STATES } from './domain/lifecycle';
export type { ConnectorState } from './domain/lifecycle';
// Space deletion's connectors leg (docs/features/spaces.md section 5).
export { ConnectorSpaceCleanup, ConnectorSpaceCleanupModule } from './connector-space-cleanup';
