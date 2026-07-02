/** Public interface of the identity seam (§A.1 rule 1). */
export { IdentityModule } from './identity.module';
export { IdentityService } from './identity.service';
export { BearerAuthGuard } from './bearer-auth.guard';
export type { AuthenticatedRequest } from './bearer-auth.guard';
export type { IdentityOptions } from './identity-options';
