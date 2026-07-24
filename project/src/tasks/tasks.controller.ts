import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TaskCountDto, TaskDto } from '@cogeto/shared';
import { TASK_STATUSES } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { TasksEngine } from './tasks.engine';
import type { TaskRow } from './persistence/tables';
import type { TaskConclusionDto } from './task-conclusion';

const listQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  entity: z.string().max(200).optional(),
  includeSettled: z.enum(['true', 'false']).optional(),
});

const adoptBodySchema = z.object({ memoryId: z.string().uuid() });

function toDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    primaryPerson: row.primaryPerson,
    entities: row.entities,
    conditionText: row.conditionText,
    conditionMet: row.conditionMet,
    due: row.due?.toISOString() ?? null,
    dormant: row.dormant,
    fromUncertain: row.fromUncertain,
    adopted: row.adopted,
    derivedFromMemoryId: row.derivedFromMemoryId,
    closedByMemoryId: row.closedByMemoryId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The minimal, deliberately debug-grade task surface (decision 0013; the real
 * UI is O2 per docs/handoff/F3-tasks.md). Owner-only; the three user
 * operations are audited inside the engine.
 */
@Controller('tasks')
@UseGuards(BearerAuthGuard)
export class TasksController {
  constructor(private readonly engine: TasksEngine) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<TaskDto[]> {
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const rows = await this.engine.listForPrincipal(request.principal, {
      statuses: parsed.data.status ? [parsed.data.status] : undefined,
      entity: parsed.data.entity,
      includeSettled: parsed.data.includeSettled === 'true',
    });
    return rows.map(toDto);
  }

  /** The nav badge: open + blocked, owner-scoped (F3 handoff §4). */
  @Get('count')
  async count(@Req() request: AuthenticatedRequest): Promise<TaskCountDto> {
    return { open: await this.engine.countOpenForPrincipal(request.principal) };
  }

  /** The conclusions a task produced (decision 0037) — "this task produced
   * this fact", each resolved to its admitted memory. Owner-only. */
  @Get(':id/conclusions')
  async conclusions(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TaskConclusionDto[]> {
    return this.engine.listConclusionsForPrincipal(request.principal, id);
  }

  /** One conclusion row — the source drawer's context for a memory whose
   * provenance is source_type 'task_conclusion'. Owner-only. */
  @Get('conclusions/:id')
  async conclusion(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TaskConclusionDto> {
    const dto = await this.engine.getConclusionForPrincipal(request.principal, id);
    if (!dto) throw new NotFoundException(`conclusion ${id} not found`);
    return dto;
  }

  /**
   * "Make this a task" (P6.5; decision 0054): adopt an observed memory as the
   * caller's own task through the existing derivation engine — the deliberate
   * first-person act the derivation rule requires. Owner-only; idempotent (a
   * memory that already carries a task returns it unchanged); audited as
   * `task.adopted` inside the engine.
   */
  @Post('adopt')
  async adopt(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<TaskDto> {
    const parsed = adoptBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return toDto(await this.engine.adoptFromMemory(request.principal, parsed.data.memoryId));
  }

  @Post(':id/reopen')
  async reopen(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TaskDto> {
    return toDto(await this.engine.reopen(request.principal, id));
  }

  @Post(':id/dismiss')
  async dismiss(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TaskDto> {
    return toDto(await this.engine.dismiss(request.principal, id));
  }

  @Post(':id/complete')
  async complete(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TaskDto> {
    return toDto(await this.engine.complete(request.principal, id));
  }
}
