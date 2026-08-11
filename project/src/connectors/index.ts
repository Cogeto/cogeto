/** Public interface of the connectors platform (spec §15 rule 1). */
export { ConnectorsModule, ConnectorItemCascadeModule } from './connectors.module';
export { ConnectorRegistry } from './connector-registry';
export { ConnectorSyncEngine } from './sync-engine';
export { ConnectorWebhookProcessor } from './webhook-processor';
export { ConnectorMaintenance } from './maintenance';
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
} from './connector-jobs';
export { UpstreamAuthError, UpstreamRateLimitError } from './connector-descriptor';
export type {
  ConnectorDescriptor,
  ConnectorSecrets,
  ConnectorWebhookScheme,
  ConnectorRateProfile,
  FetchPageArgs,
  FetchPageResult,
  UpstreamItem,
  UpstreamItemRef,
} from './connector-descriptor';
export { CONNECTOR_STATES } from './domain/lifecycle';
export type { ConnectorState } from './domain/lifecycle';
