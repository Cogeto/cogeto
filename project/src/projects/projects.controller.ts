import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { ProjectAssignmentDto, ProjectDto } from '@cogeto/shared';
import { PROJECT_ASSIGNMENT_KINDS, PROJECT_MARKERS, projectRefTypeFor } from '@cogeto/shared';
import { parseOrBadRequest, userError } from '../infrastructure/index';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { ProjectService } from './project.service';

/** Zod at the boundary. A project is a folder, so the bounds are a folder's. */
const extractionSchema = z.object({
  enabled: z.boolean().nullable().optional(),
  factBudget: z.number().int().min(1).max(1000).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
});

const writeSchema = z.object({
  name: z.string().max(80, 'name is too long (max 80 characters)'),
  description: z.string().max(500).nullable().optional(),
  marker: z.enum(PROJECT_MARKERS).nullable().optional(),
  lensEnabled: z.boolean().optional(),
  extraction: extractionSchema.optional(),
});

const patchSchema = writeSchema.partial();

const archiveSchema = z.object({ archived: z.boolean() });

/**
 * Assignment is one shape for all five kinds. `projectId: null` unassigns,
 * which is the same call in the other direction: nothing about assignment is
 * one-way, and nothing about it is a permission.
 */
const assignSchema = z.object({
  kind: z.enum(PROJECT_ASSIGNMENT_KINDS),
  /** Required for `source` (it is the source type); derived for the rest. */
  sourceType: z.string().min(1).max(64).optional(),
  refId: z.string().min(1).max(512),
  projectId: z.uuid().nullable(),
});

const listSchema = z.object({
  archived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

@Controller('projects')
@UseGuards(BearerAuthGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown): Promise<ProjectDto[]> {
    const parsed = parseOrBadRequest(listSchema, query ?? {});
    return this.projects.list(request.principal, { archived: parsed.archived });
  }

  @Post()
  async create(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<ProjectDto> {
    return this.projects.create(request.principal, parseOrBadRequest(writeSchema, body));
  }

  @Get(':id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProjectDto> {
    return this.projects.get(request.principal, id);
  }

  @Get(':id/assignments')
  async assignments(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProjectAssignmentDto[]> {
    return this.projects.assignments(request.principal, id);
  }

  @Put(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ProjectDto> {
    return this.projects.update(request.principal, id, parseOrBadRequest(patchSchema, body));
  }

  /** Archive / unarchive: the safe action, and the one the interface offers. */
  @Put(':id/archived')
  async setArchived(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ProjectDto> {
    const parsed = parseOrBadRequest(archiveSchema, body);
    return this.projects.setArchived(request.principal, id, parsed.archived);
  }

  /**
   * Deleting a project deletes the FOLDER, never its contents. The response
   * says how many assignments were released so the interface can confirm what
   * actually happened in the same words the dialog promised.
   */
  @Delete(':id')
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ released: number }> {
    return this.projects.delete(request.principal, id);
  }

  /** Assign, move, or unassign one thing. */
  @Post('assignments')
  async assign(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ projectId: string | null }> {
    const parsed = parseOrBadRequest(assignSchema, body);
    if (parsed.kind === 'source' && !parsed.sourceType) {
      throw userError.badRequest(
        'project.assignmentNeedsSourceType',
        'a source assignment needs its source type',
      );
    }
    return this.projects.assign(
      request.principal,
      {
        kind: parsed.kind,
        refType: projectRefTypeFor(parsed.kind, parsed.sourceType),
        refId: parsed.refId,
      },
      parsed.projectId,
    );
  }
}
