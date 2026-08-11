/** Public interface of the identity seam (spec §15 rule 1). */
export { IdentityModule } from './identity.module';
export { IdentityService } from './identity.service';
export { UserDirectory } from './user-directory';
export { PRINCIPAL } from './principal.provider';
export { BearerAuthGuard } from './bearer-auth.guard';
export type { AuthenticatedRequest } from './bearer-auth.guard';
export type { IdentityOptions } from './identity-options';
// The demo sandbox login's file contract and reader; the demo bootstrap CLI
// writes the same files (V2.0 item 3.6 part 2).
export { DEMO_USERNAME, demoLoginFile, readDemoLogin } from './demo-login';
export type { DemoCredentials } from './demo-login';
export { Public } from './public.decorator';
export { AdminGuard } from './admin.guard';
// Connector credential storage inside the identity seam (V2.5 item 8.1).
// The store writes, describes and destroys; the OPENER decrypts and exists
// only in roots registered with `credentialReads: true` (the worker).
export {
  ConnectorCredentialStore,
  ConnectorCredentialOpener,
} from './persistence/connector-credential-store';
export type {
  CredentialMaterial,
  ConnectorCredentialSummary,
  OpenedCredential,
  StoreCredentialInput,
} from './persistence/connector-credential-store';
