import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
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
import { parseOrBadRequest, userError } from '../infrastructure/index';

const proposeSchema = z.object({
  intent: z
    .string()
    .max(500, 'research request is too long (max 500 characters)')
    .refine((value) => value.trim().length > 0, 'research request must not be blank'),
  /** The invoking chat conversation — the concluded answer is
   * appended there. Absent for Research-page proposals. */
  conversationId: z.uuid().optional(),
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
    concludedAt: row.concludedAt?.toISOString() ?? null,
    answerSeenAt: row.answerSeenAt?.toISOString() ?? null,
    fromSkill: row.skillRunId !== null,
  };
}

/**
 * The research-run surface —
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
    const parsed = parseOrBadRequest(proposeSchema, body);
    return toDto(
      await this.research.propose(
        request.principal,
        parsed.intent.trim(),
        parsed.conversationId ?? null,
      ),
    );
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
    if (!row) throw userError.notFound('research.runNotFound', 'no such research run');
    return toDto(row);
  }

  /** THE approval: records the exact (possibly edited) text, then searches. */
  @Post('runs/:id/approve')
  async approve(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ApproveResearchResponse> {
    const parsed = parseOrBadRequest(approveSchema, body);
    const { run, search } = await this.research.approveAndSearch(
      request.principal,
      id,
      parsed.query,
    );
    if (search.status === 'unavailable') {
      // The approval is recorded; the engine is not reachable. 503 keeps the
      // typed retryable semantics — approving again with the SAME query retries.
      // The engine's own words for why it is unreachable: text we did not
      // write, so it travels as the detail of a sentence we did.
      throw userError.unavailable(
        'search_unavailable',
        'the search engine is unavailable: {{detail}}',
        { detail: search.reason },
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

  /** The in-chat flow's progress feed: per-page pipeline
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
    const parsed = parseOrBadRequest(captureSchema, body);
    const results = await this.research.capture(request.principal, parsed.urls, 'private', id);
    return { results };
  }

  /** The answer-tier synthesis with per-claim [W#]/[M#] provenance. A run the
   * worker already concluded replays its STORED answer. */
  @Post('runs/:id/synthesise')
  async synthesise(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResearchAnswerDto> {
    return this.synthesis.synthesise(request.principal, id);
  }

  /** The owner saw the stored answer: the chat resume surface
   * stops showing this run. Idempotent. */
  @Post('runs/:id/seen')
  async seen(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ ok: true }> {
    await this.research.markAnswerSeen(request.principal, id);
    return { ok: true };
  }
}
