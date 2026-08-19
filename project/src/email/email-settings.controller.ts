import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { EmailAliasDto, EmailAllowlistEntryDto, EmailCaptureConfigDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { EmailAllowlistService } from './email-allowlist.service';
import { MAIL_OPTIONS } from './mail-options';
import type { MailOptions } from './mail-options';
import { parseOrBadRequest, userError } from '../infrastructure/index';

const addEntrySchema = z.object({
  kind: z.enum(['address', 'domain']),
  value: z.string().min(1).max(320),
  note: z.string().max(500).optional().nullable(),
  spaceId: z.uuid().optional(),
});

const addAliasSchema = z.object({
  alias: z.string().min(1).max(64),
  spaceId: z.uuid(),
  note: z.string().max(500).optional().nullable(),
});

/**
 * /api/email — the owner's Email capture surface
 * the inbound address (read-only) with its forwarding-setup guidance, the sender
 * allowlist (view/add/remove, audited), and recent refusals for one-click
 * allowlisting.
 */
@Controller('email')
@UseGuards(BearerAuthGuard)
export class EmailSettingsController {
  constructor(
    private readonly allowlist: EmailAllowlistService,
    @Inject(MAIL_OPTIONS) private readonly options: MailOptions,
  ) {}

  @Get('config')
  async config(@Req() request: AuthenticatedRequest): Promise<EmailCaptureConfigDto> {
    const [allowlist, aliases, recentRefusals] = await Promise.all([
      this.allowlist.listForOwner(request.principal.userId),
      this.allowlist.listAliasesForOwner(request.principal.userId),
      this.allowlist.recentRefusalsForOwner(request.principal.userId),
    ]);
    return {
      inboundAddress: this.options.inboundAddress,
      // The caller's own address is implicitly trusted (rule 1).
      selfAddress: request.principal.email ?? null,
      allowlist,
      aliases,
      recentRefusals,
    };
  }

  @Post('allowlist')
  async addEntry(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<EmailAllowlistEntryDto> {
    const parsed = parseOrBadRequest(addEntrySchema, body);
    return this.allowlist.addEntry(request.principal, parsed);
  }

  @Delete('allowlist/:id')
  @HttpCode(204)
  async removeEntry(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const removed = await this.allowlist.removeEntry(request.principal, id);
    if (!removed)
      throw userError.notFound('email.allowlistEntryNotFound', 'allowlist entry not found');
  }

  /** Alias routing rules (docs/features/spaces.md section 6c). */
  @Post('aliases')
  async addAlias(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<EmailAliasDto> {
    const parsed = parseOrBadRequest(addAliasSchema, body);
    return this.allowlist.addAlias(request.principal, parsed);
  }

  @Delete('aliases/:id')
  @HttpCode(204)
  async removeAlias(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const removed = await this.allowlist.removeAlias(request.principal, id);
    if (!removed) throw userError.notFound('email.aliasNotFound', 'alias not found');
  }
}
