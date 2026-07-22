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
import type { ResearchCaptureResponse, WebSourceDto } from '@cogeto/shared';
import { MEMORY_SCOPES } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { ResearchService } from './research.service';

/** Zod at the boundary: a bounded URL selection. */
const captureSchema = z.object({
  urls: z
    .array(z.string().max(2000, 'URL is too long'))
    .min(1, 'select at least one URL')
    .max(50, 'too many URLs in one request'),
  scope: z.enum(MEMORY_SCOPES).optional(),
});

/**
 * Direct web-capture endpoints (Priority 5 Part A, gated per Part B) —
 * explicitly invoked, owner-scoped. NOTE (decision 0045): there is NO raw
 * search endpoint any more — a query reaches discovery only through the
 * show-edit-approve gate (`ResearchRunController.approve`). Direct URL capture
 * remains: fetching a URL the user explicitly pasted sends no query anywhere.
 * Budget exhaustion surfaces as 429 `daily_research_limit` from the service.
 */
@Controller('research')
@UseGuards(BearerAuthGuard)
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

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
      // Part B provenance: the approved query that led to this page, one
      // click from every research-derived memory. Null for direct captures.
      sentQuery: await this.research.sentQueryFor(row),
    };
  }
}
