import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { PassportDownloadDto, PassportExportDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { PassportService } from './passport.service';

const triggerSchema = z.object({ includeOriginals: z.boolean().optional() }).default({});

/**
 * /api/passport — the Memory Passport (§B.5, decision 0029). Every route is
 * owner-scoped: a user triggers, polls, and downloads only their OWN export, and
 * the artifact contains only what they are entitled to see (the gates run in the
 * worker's assembly reads).
 */
@Controller('passport')
@UseGuards(BearerAuthGuard)
export class PassportController {
  constructor(private readonly passport: PassportService) {}

  /** Trigger an export (worker-assembled). Returns the request to poll. */
  @Post('exports')
  async trigger(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<PassportExportDto> {
    const parsed = triggerSchema.parse(body ?? {});
    return this.passport.trigger(request.principal, parsed.includeOriginals ?? false);
  }

  /** The caller's recent exports, newest first. */
  @Get('exports')
  async list(@Req() request: AuthenticatedRequest): Promise<PassportExportDto[]> {
    return this.passport.list(request.principal);
  }

  /** One export's status — the poll target. */
  @Get('exports/:id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PassportExportDto> {
    return this.passport.get(request.principal, id);
  }

  /** A short-lived signed download URL for a ready export. */
  @Get('exports/:id/download')
  async download(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PassportDownloadDto> {
    return this.passport.download(request.principal, id);
  }
}
