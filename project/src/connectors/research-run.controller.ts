import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type {
  ApproveResearchResponse,
  ResearchAnswerDto,
  ResearchCaptureResponse,
  ResearchRunDto,
  ResearchRunProgressDto,
} from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { ResearchService } from './research.service';
import { ResearchSynthesisService } from './research-synthesis.service';
import type { ResearchRunRow } from './persistence/tables';

const proposeSchema = z.object({
  intent: z
    .string()
    .max(500, 'research request is too long (max 500 characters)')
    .refine((value) => value.trim().length > 0, 'research request must not be blank'),
});

const approveSchema = z.object({
  query: z
    .string()
    .max(500, 'query is too long (max 500 characters)')
    .refine((value) => value.trim().length > 0, 'query must not be blank'),
});

const captureSchema = z.object({
  urls: z.array(z.string().max(2000)).min(1, 'select at least one URL').max(50),
});

function toDto(row: ResearchRunRow): ResearchRunDto {
  return {
    id: row.id,
    status: row.status,
    intent: row.intent,
    proposedQuery: row.proposedQuery,
    minimisedQuery: row.minimisedQuery,
    minimiseReason: row.minimiseReason,
    sentQuery: row.sentQuery,
    answer: row.answer,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

/**
 * The research-run surface (Priority 5 Part B; decisions 0044/0045) —
 * propose → (edit) → approve-or-cancel → capture → synthesise. Composed only
 * into the app root (ResearchChatModule): research is an interactive flow,
 * never worker work. Discovery has NO other HTTP path — the Part A raw search
 * endpoint was removed with this unit.
 */
@Controller('research')
@UseGuards(BearerAuthGuard)
export class ResearchRunController {
  constructor(
    private readonly research: ResearchService,
    private readonly synthesis: ResearchSynthesisService,
  ) {}

  /** Open the gate: minimise + record. Sends nothing. */
  @Post('propose')
  async propose(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ResearchRunDto> {
    const parsed = proposeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return toDto(await this.research.propose(request.principal, parsed.data.intent.trim()));
  }

  @Get('runs')
  async list(@Req() request: AuthenticatedRequest): Promise<ResearchRunDto[]> {
    return (await this.research.listRuns(request.principal)).map(toDto);
  }

  @Get('runs/:id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResearchRunDto> {
    const row = await this.research.getRun(request.principal, id);
    if (!row) throw new NotFoundException();
    return toDto(row);
  }

  /** THE approval: records the exact (possibly edited) text, then searches. */
  @Post('runs/:id/approve')
  async approve(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ApproveResearchResponse> {
    const parsed = approveSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { run, search } = await this.research.approveAndSearch(
      request.principal,
      id,
      parsed.data.query,
    );
    if (search.status === 'unavailable') {
      // The approval is recorded; the engine is not reachable. 503 keeps the
      // typed retryable semantics — approving again with the SAME query retries.
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          error: 'Service Unavailable',
          code: 'search_unavailable',
          message: search.reason,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { run: toDto(run), search };
  }

  @Post('runs/:id/cancel')
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResearchRunDto> {
    return toDto(await this.research.cancel(request.principal, id));
  }

  /** The in-chat flow's progress feed (decision 0047): per-page pipeline
   * state + derived-fact count. Owner-gated; read-only. */
  @Get('runs/:id/progress')
  async progress(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResearchRunProgressDto> {
    const pages = await this.research.runProgress(request.principal, id);
    return { runId: id, pages };
  }

  /** Fetch the user-selected pages under this run (Part A capture, run-tagged). */
  @Post('runs/:id/capture')
  async capture(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ResearchCaptureResponse> {
    const parsed = captureSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const results = await this.research.capture(request.principal, parsed.data.urls, 'private', id);
    return { results };
  }

  /** The answer-tier synthesis with per-claim [W#]/[M#] provenance. */
  @Post('runs/:id/synthesise')
  async synthesise(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResearchAnswerDto> {
    return this.synthesis.synthesise(request.principal, id);
  }
}
