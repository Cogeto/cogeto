import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { UserSettingsDto } from '@cogeto/shared';
import { MEMORY_SCOPES } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { UserSettingsService } from './user-settings.service';
import { parseOrBadRequest } from '../infrastructure/index';

const updateSchema = z
  .object({
    discardByDefault: z.boolean(),
    defaultScope: z.enum(MEMORY_SCOPES),
    autoResearch: z.boolean(),
  })
  .partial();

/**
 * /api/settings — the owner's capture/upload defaults IN THE CALLER'S SPACE
 * (the settings split, docs/features/spaces.md section 4): the
 * extract-and-discard default, the default scope, and the auto-research
 * toggle. Only real, wired toggles. The instance public key shown in the UI
 * is served separately by /api/instance/public-key (F1); Settings does not
 * duplicate it.
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
    const parsed = parseOrBadRequest(updateSchema, body);
    return this.settings.update(request.principal, parsed);
  }
}
