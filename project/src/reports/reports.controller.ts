import {
  Body,
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
import type { FindingsReportDto, ReportDownloadDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { parseOrBadRequest } from '../infrastructure/index';
import { ReportService } from './report.service';

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('corpus') }),
  z.object({ kind: z.literal('import'), importRunId: z.uuid() }),
  z.object({
    kind: z.literal('sources'),
    refs: z
      .array(z.object({ sourceType: z.string().min(1), sourceId: z.string().min(1) }))
      .min(1)
      .max(200),
  }),
  z.object({
    kind: z.literal('date_range'),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  }),
  /** A project (V2.5 item 8.3): the run enumerates exactly that project's
   * source assignments, so a client-facing report cannot contain another
   * client's documents. */
  z.object({ kind: z.literal('project'), projectId: z.uuid() }),
]);

const triggerSchema = z.object({ scope: scopeSchema });

const downloadQuerySchema = z.object({ format: z.enum(['pdf', 'json']) });

/**
 * /api/reports — the findings report (V2.3 item 6.2). Every route is
 * owner-scoped: a user triggers, polls, and downloads only their OWN runs, and
 * the artifact contains only what they are entitled to see (the gates run in
 * the worker's assembly reads).
 */
@Controller('reports')
@UseGuards(BearerAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportService) {}

  /** Trigger a findings run (worker-generated). Returns the run to poll. */
  @Post()
  async trigger(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<FindingsReportDto> {
    const parsed = parseOrBadRequest(triggerSchema, body ?? {});
    return this.reports.trigger(request.principal, parsed.scope);
  }

  /** The caller's recent runs, newest first. */
  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<FindingsReportDto[]> {
    return this.reports.list(request.principal);
  }

  /** One run's status and progress — the poll target. */
  @Get(':id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FindingsReportDto> {
    return this.reports.get(request.principal, id);
  }

  /** A short-lived signed download URL for a ready run, per format. */
  @Get(':id/download')
  async download(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ): Promise<ReportDownloadDto> {
    const parsed = parseOrBadRequest(downloadQuerySchema, query ?? {});
    return this.reports.download(request.principal, id, parsed.format);
  }
}
