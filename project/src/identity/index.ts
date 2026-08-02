/** Public interface of the identity seam (spec §15 rule 1). */
export { IdentityModule } from './identity.module';
export { IdentityService } from './identity.service';
export { UserDirectory } from './user-directory';
export { PRINCIPAL } from './principal.provider';
export { BearerAuthGuard } from './bearer-auth.guard';
export type { AuthenticatedRequest } from './bearer-auth.guard';
export type { IdentityOptions, WebConfigOptions } from './identity-options';
// The demo sandbox login's file contract and reader; the demo bootstrap CLI
// writes the same files (V2.0 item 3.6 part 2).
export { DEMO_USERNAME, demoLoginFile, readDemoLogin } from './demo-login';
export type { DemoCredentials } from './demo-login';
export { Public, IS_PUBLIC_KEY } from './public.decorator';
export { AdminGuard } from './admin.guard';
