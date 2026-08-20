/** Public interface of the providers module (spec §15 rule 1). */
export { ProvidersModule } from './providers.module';
export { ProviderConfigService, REINDEX_COMMAND } from './provider-config.service';
export { PROVIDERS_OPTIONS } from './providers.options';
export type { ProvidersOptions } from './providers.options';
// The boot path: seed the environment in once, then resolve what the instance
// actually runs (V2.4 item 7.1). Called by every composition root and by the
// bare entrypoints that talk to models, so no process can disagree about which
// configuration is active.
export { loadModelConfiguration } from './load-configuration';
// The sealed-secret mechanism moved to infrastructure in V2.5 item 8.1 (one
// mechanism for provider keys and connector credentials); consumers import
// readMasterKey / MasterKeyError from the infrastructure barrel now.
export { PROVIDER_TYPE_SPECS } from './domain/provider-types';
// The boot-time managed provider reconciler (hosted provisioning, task A):
// called by both composition roots between installing the database's model
// configuration and the embedding-space guard. Absent configuration is a
// no-op; a malformed or half-present one refuses the boot.
export { ManagedReconcileError, reconcileManagedProvider } from './managed-reconcile';
export type { ManagedReconcileDeps, ManagedReconcileInput } from './managed-reconcile';
export { ManagedProviderConfigError } from './domain/managed-config';
