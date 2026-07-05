import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { TaskDto } from '@cogeto/shared';
import { TASK_STATUSES } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { TasksEngine } from './tasks.engine';
import type { TaskRow } from './persistence/tables';

const listQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  entity: z.string().max(200).optional(),
  includeSettled: z.enum(['true', 'false']).optional(),
});

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
    derivedFromMemoryId: row.derivedFromMemoryId,
    closedByMemoryId: row.closedByMemoryId,
    createdAt: row.createdAt.toISOString(),
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
