import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import type { MeDto } from '@cogeto/shared';
import { BearerAuthGuard } from './bearer-auth.guard';
import type { AuthenticatedRequest } from './bearer-auth.guard';
import { IDENTITY_OPTIONS } from './identity-options';
import type { IdentityOptions } from './identity-options';

/**
 * GET /api/me — the authenticated Principal for the dashboard shell, plus the
 * server-computed `isAdmin` flag (the configured admin role, QS-10) so the SPA
 * can hide operator surfaces (System) from plain users without hardcoding a
 * role name. Display-gating only: AdminGuard stays the enforcement on the
 * admin endpoints themselves.
 */
@Controller('me')
@UseGuards(BearerAuthGuard)
export class MeController {
  constructor(@Inject(IDENTITY_OPTIONS) private readonly options: IdentityOptions) {}

  @Get()
  me(@Req() request: AuthenticatedRequest): MeDto {
    const role = this.options.adminRole ?? 'admin';
    return { ...request.principal, isAdmin: request.principal.roles.includes(role) };
  }
}
