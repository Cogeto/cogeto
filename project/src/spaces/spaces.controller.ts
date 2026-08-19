import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { SpaceDto, SpaceListDto } from '@cogeto/shared';
import { parseOrBadRequest } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { SpaceService } from './space.service';

const nameSchema = z.object({ name: z.string().min(1).max(120) });
const currentSchema = z.object({ spaceId: z.uuid() });

/**
 * The spaces API (docs/features/spaces.md), data and API only this session.
 * Machine-facing until the switcher lands, so failures are untranslated
 * developer/machine errors (F13), never serverErrors keys.
 */
@Controller('spaces')
@UseGuards(BearerAuthGuard)
export class SpacesController {
  constructor(private readonly spaces: SpaceService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<SpaceListDto> {
    const [spaces, currentSpaceId] = await Promise.all([
      this.spaces.list(),
      this.spaces.currentFor(request.principal),
    ]);
    return { spaces, currentSpaceId };
  }

  /** Create, and switch the creator into the new space immediately (the
   * record's create flow); persisting last-used is that switch's data half. */
  @Post()
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<SpaceDto> {
    const parsed = parseOrBadRequest(nameSchema, body);
    const created = await this.spaces.create(request.principal, parsed.name);
    await this.spaces.setCurrent(request.principal, created.id);
    return created;
  }

  @Put('current')
  async setCurrent(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ currentSpaceId: string }> {
    const parsed = parseOrBadRequest(currentSchema, body);
    const currentSpaceId = await this.spaces.setCurrent(request.principal, parsed.spaceId);
    return { currentSpaceId };
  }

  @Patch(':id')
  async rename(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<SpaceDto> {
    const parsed = parseOrBadRequest(nameSchema, body);
    return this.spaces.rename(request.principal, id, parsed.name);
  }
}
