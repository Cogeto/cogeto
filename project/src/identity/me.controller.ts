import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import { BearerAuthGuard } from './bearer-auth.guard';
import type { AuthenticatedRequest } from './bearer-auth.guard';

/** GET /api/me — the authenticated Principal for the dashboard shell. */
@Controller('me')
@UseGuards(BearerAuthGuard)
export class MeController {
  @Get()
  me(@Req() request: AuthenticatedRequest): Principal {
    return request.principal;
  }
}
