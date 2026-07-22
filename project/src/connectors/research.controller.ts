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
import type { ResearchCaptureResponse, ResearchSearchResponse, WebSourceDto } from '@cogeto/shared';
import { MEMORY_SCOPES } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { ResearchService } from './research.service';

/** Zod at the boundary: a non-blank bounded query; a bounded URL selection. */
const searchSchema = z.object({
  query: z
    .string()
    .max(500, 'query is too long (max 500 characters)')
    .refine((value) => value.trim().length > 0, 'query must not be blank'),
});

const captureSchema = z.object({
  urls: z
    .array(z.string().max(2000, 'URL is too long'))
    .min(1, 'select at least one URL')
    .max(50, 'too many URLs in one request'),
  scope: z.enum(MEMORY_SCOPES).optional(),
});

/**
 * Web research endpoints (Priority 5 Part A) — explicitly invoked, owner-scoped.
 * Search unavailability surfaces as 503 `search_unavailable` (typed, retryable
 * by the user), never a crash; budget exhaustion surfaces as 429
 * `daily_research_limit` from the service.
 */
@Controller('research')
@UseGuards(BearerAuthGuard)
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  @Post('search')
  async search(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ResearchSearchResponse> {
    const parsed = searchSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const outcome = await this.research.search(request.principal, parsed.data.query.trim());
    if (outcome.status === 'unavailable') {
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          error: 'Service Unavailable',
          code: 'search_unavailable',
          message: outcome.reason,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return outcome;
  }

  @Post('capture')
  async capture(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ResearchCaptureResponse> {
    const parsed = captureSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const results = await this.research.capture(
      request.principal,
      parsed.data.urls,
      parsed.data.scope ?? 'private',
    );
    return { results };
  }

  /** The retained page — the source drawer target (owner-only). */
  @Get(':id/source')
  async source(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WebSourceDto> {
    const row = await this.research.getForOwner(request.principal, id);
    if (!row) throw new NotFoundException();
    return {
      id: row.id,
      requestedUrl: row.requestedUrl,
      finalUrl: row.finalUrl,
      title: row.title,
      fetchedAt: row.fetchedAt.toISOString(),
      retainedText: row.retainedText,
      scope: row.scope,
      sensitive: row.sensitive,
      state: await this.research.getProcessingState(row.id),
    };
  }
}
