import { BadRequestException, Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { UserSettingsDto } from '@cogeto/shared';
import { MEMORY_SCOPES } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { UserSettingsService } from './user-settings.service';

const updateSchema = z
  .object({
    discardByDefault: z.boolean(),
    defaultScope: z.enum(MEMORY_SCOPES),
  })
  .partial();

/**
 * /api/settings — the owner's per-user capture/upload defaults (§A.9, O1-C).
 * Only real, wired toggles: the extract-and-discard default and the default
 * scope. The instance public key shown in the UI is served separately by
 * /api/instance/public-key (F1); Settings does not duplicate it.
 */
@Controller('settings')
@UseGuards(BearerAuthGuard)
export class SettingsController {
  constructor(private readonly settings: UserSettingsService) {}

  @Get()
  async get(@Req() request: AuthenticatedRequest): Promise<UserSettingsDto> {
    return this.settings.get(request.principal);
  }

  @Put()
  async update(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<UserSettingsDto> {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.settings.update(request.principal, parsed.data);
  }
}
