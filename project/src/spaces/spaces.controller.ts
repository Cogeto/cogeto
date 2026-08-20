import {
  Body,
  Controller,
  Delete,
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
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import type { MachineSpaceBindingDto, SpaceDto, SpaceListDto } from '@cogeto/shared';
import { parseOrBadRequest, userError } from '../infrastructure/index';
import { AdminGuard, BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { SpaceService } from './space.service';
import { SpaceErasureService } from './space-erasure.service';
import type { SpaceDeletionPlan } from './space-erasure.service';
import { MachineBindingService } from './machine-binding.service';

const nameSchema = z.object({ name: z.string().min(1).max(120) });
const currentSchema = z.object({ spaceId: z.uuid() });
const bindSchema = z.object({ spaceId: z.uuid() });

/**
 * The spaces API (docs/features/spaces.md). The switcher (session 3) made
 * this a person-facing surface, so the failures a user can cause carry
 * serverErrors codes (F13); only the worker-side erasure pass keeps
 * untranslated developer errors.
 */
@Controller('spaces')
@UseGuards(BearerAuthGuard)
export class SpacesController {
  constructor(
    private readonly spaces: SpaceService,
    private readonly erasure: SpaceErasureService,
    private readonly machineBindings: MachineBindingService,
  ) {}

  /**
   * Machine callers' per-credential space bindings (docs/features/spaces.md
   * section 6c): administrator-only, because binding a credential to a
   * partition is an instance-shaping act. The routes are declared before the
   * `:id` family so 'machine-bindings' can never be read as a space id.
   */
  @Get('machine-bindings')
  @UseGuards(AdminGuard)
  async listMachineBindings(): Promise<{ bindings: MachineSpaceBindingDto[] }> {
    return { bindings: await this.machineBindings.list() };
  }

  @Put('machine-bindings/:userId')
  @UseGuards(AdminGuard)
  async bindMachine(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<MachineSpaceBindingDto> {
    const parsed = parseOrBadRequest(bindSchema, body);
    return this.machineBindings.bind(request.principal, userId.trim(), parsed.spaceId);
  }

  @Delete('machine-bindings/:userId')
  @UseGuards(AdminGuard)
  async unbindMachine(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
  ): Promise<void> {
    const removed = await this.machineBindings.unbind(request.principal, userId.trim());
    if (!removed) throw userError.notFound('spaces.bindingNotFound', 'no binding for that user');
  }

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<SpaceListDto> {
    const [spaces, currentSpaceId] = await Promise.all([
      this.spaces.list(),
      this.spaces.currentFor(request.principal),
    ]);
    // The two reads run in parallel, so a space deleted BETWEEN them could
    // hand the client a current space the list does not contain, which the
    // SPA would bind for up to a poll interval (spaces verification F13).
    // The list is what the client renders, so the pointer degrades against
    // it, the same way a deleted last-used space degrades to the default.
    const current = spaces.some((s) => s.id === currentSpaceId) ? currentSpaceId : DEFAULT_SPACE_ID;
    return { spaces, currentSpaceId: current };
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

  /** What deleting the space WOULD erase: the numbers the next session's
   * confirmation surface states (docs/features/spaces.md section 5). */
  @Get(':id/deletion-plan')
  @UseGuards(AdminGuard)
  async deletionPlan(@Param('id', ParseUUIDPipe) id: string): Promise<SpaceDeletionPlan> {
    return this.erasure.plan(id);
  }

  /**
   * Delete the space: enumerate its sources and run the ORDINARY deletion
   * saga per source in the worker, one receipt per source, then remove its
   * containers and the row itself. ADMINISTRATOR-ONLY, because a space seals
   * content, not people — it holds every user's material, and deleting it is
   * an instance-shaping act like erasing a departed user. Returns the plan
   * (the honest numbers at the moment of the request); the erasure itself is
   * the enqueued worker pass.
   */
  @Delete(':id')
  @UseGuards(AdminGuard)
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SpaceDeletionPlan> {
    return this.erasure.request(request.principal, id);
  }
}
