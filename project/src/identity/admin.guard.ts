import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { IDENTITY_OPTIONS } from './identity-options';
import type { IdentityOptions } from './identity-options';
import type { AuthenticatedRequest } from './bearer-auth.guard';

/**
 * Requires the operator/admin project role (FIX-3 QS-10). Runs AFTER the global
 * BearerAuthGuard has attached the Principal (so `roles` is populated). Gates
 * the System-view queue endpoints, whose reads expose cross-user source ids and
 * whose retry replays any parked job — an operator concern, not per-user data.
 * A member without the role gets 403.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(IDENTITY_OPTIONS) private readonly options: IdentityOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const role = this.options.adminRole ?? 'admin';
    if (!request.principal?.roles?.includes(role)) {
      throw new ForbiddenException(`this endpoint requires the '${role}' role`);
    }
    return true;
  }
}
