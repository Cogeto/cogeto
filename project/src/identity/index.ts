/** Public interface of the identity seam (§A.1 rule 1). */
export { IdentityModule } from './identity.module';
export { IdentityService } from './identity.service';
export { UserDirectory } from './user-directory';
export { PRINCIPAL } from './principal.provider';
export { BearerAuthGuard } from './bearer-auth.guard';
export type { AuthenticatedRequest } from './bearer-auth.guard';
export type { IdentityOptions } from './identity-options';
export { Public, IS_PUBLIC_KEY } from './public.decorator';
export { AdminGuard } from './admin.guard';
