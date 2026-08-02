import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type {
  Principal,
  ProposeSkillRunResponse,
  ResearchCitationDto,
  SkillPlanQueryDto,
  SkillRunDetailDto,
  SkillRunDto,
  SkillRunStepDto,
  SkillStepKind,
  SkillStepLinks,
} from '@cogeto/shared';
import { BearerAuthGuard } from '../../identity/index';
import type { AuthenticatedRequest } from '../../identity/index';
import { ResearchService } from '../../research/index';
import type { SkillRunRow, SkillRunStepRow } from '../persistence/tables';
import type { ResearchRunRow } from '../../research/index';
import { getSkill } from './skill-registry';
import { SkillEngine } from './skill-engine';
import { SkillPlanner } from './skill-planner';
import { SkillRunService } from './skill-run.service';

const proposeSchema = z.object({
  skillId: z.string().min(1).max(100),
  subject: z
    .string()
    .max(200, 'subject is too long (max 200 characters)')
    .refine((value) => value.trim().length > 0, 'subject must not be blank'),
  /** The invoking chat conversation; recorded nowhere yet — the run view is
   * the surface. Accepted for forward compatibility. */
  conversationId: z.uuid().optional(),
});

const planSchema = z.object({
  queries: z
    .array(
      z.object({
        researchRunId: z.uuid(),
        query: z
          .string()
          .max(500, 'query is too long (max 500 characters)')
          .refine((value) => value.trim().length > 0, 'query must not be blank'),
      }),
    )
    .min(1, 'approve at least one query, or cancel the run')
    .max(20),
});

function toRunDto(row: SkillRunRow): SkillRunDto {
  const skill = getSkill(row.skillId);
  return {
    id: row.id,
    skillId: row.skillId,
    skillVersion: row.skillVersion,
    skillName: skill?.name ?? row.skillId,
    subject: row.subject,
    status: row.status,
    failureReason: row.failureReason,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toStepDto(row: SkillRunStepRow, skillId: string): SkillRunStepDto {
  const step = getSkill(skillId)?.steps.find((s) => s.key === row.stepKey);
  return {
    id: row.id,
    position: row.position,
    stepKey: row.stepKey,
    kind: row.kind as SkillStepKind,
    status: row.status,
    title: step?.title ?? row.stepKey,
    inputsSummary: row.inputsSummary,
    outputsSummary: row.outputsSummary,
    links: (row.links as SkillStepLinks) ?? {},
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function toPlanDto(row: ResearchRunRow): SkillPlanQueryDto {
  return {
    researchRunId: row.id,
    status: row.status,
    proposedQuery: row.proposedQuery,
    minimisedQuery: row.minimisedQuery,
    minimiseReason: row.minimiseReason,
    sentQuery: row.sentQuery,
  };
}

/**
 * The skill surface — propose → the plan gate →
 * the live run view → the brief. Composed only into the app root
 * (SkillsModule): planning needs retrieval; execution stays the worker's.
 */
@Controller('skills')
@UseGuards(BearerAuthGuard)
export class SkillsController {
  constructor(
    private readonly planner: SkillPlanner,
    private readonly engine: SkillEngine,
    private readonly runs: SkillRunService,
    private readonly research: ResearchService,
  ) {}

  /** Start a run: disambiguate, gather, plan — stops at the gate. Sends nothing. */
  @Post('runs')
  async propose(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ProposeSkillRunResponse> {
    const parsed = proposeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const outcome = await this.planner.propose(
      request.principal,
      parsed.data.skillId,
      parsed.data.subject.trim(),
    );
    if (outcome.status === 'ambiguous') {
      return { status: 'ambiguous', candidates: outcome.candidates };
    }
    return { status: 'created', run: await this.detail(request.principal, outcome.run) };
  }

  @Get('runs')
  async list(@Req() request: AuthenticatedRequest): Promise<SkillRunDto[]> {
    return (await this.runs.listRuns(request.principal)).map(toRunDto);
  }

  @Get('runs/:id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SkillRunDetailDto> {
    const run = await this.runs.getRun(request.principal, id);
    if (!run) throw new NotFoundException();
    return this.detail(request.principal, run);
  }

  /** The plan gate, one interaction: approve all (edited), removed = cancelled. */
  @Post('runs/:id/plan')
  async approvePlan(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<SkillRunDetailDto> {
    const parsed = planSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const run = await this.engine.approvePlan(request.principal, id, parsed.data.queries);
    return this.detail(request.principal, run);
  }

  @Post('runs/:id/cancel')
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SkillRunDetailDto> {
    const run = await this.runs.cancel(request.principal, id);
    return this.detail(request.principal, run);
  }

  private async detail(principal: Principal, run: SkillRunRow): Promise<SkillRunDetailDto> {
    const [steps, planRuns] = await Promise.all([
      this.runs.steps(run.id),
      this.research.runsForSkill(run.id),
    ]);
    return {
      ...toRunDto(run),
      steps: steps.map((step) => toStepDto(step, run.skillId)),
      plan: planRuns.map(toPlanDto),
      brief: run.brief,
      briefCitations: (run.briefCitations as ResearchCitationDto[]) ?? [],
    };
  }
}
