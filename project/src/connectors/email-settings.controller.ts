import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { EmailAllowlistEntryDto, EmailCaptureConfigDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { EmailAllowlistService } from './email-allowlist.service';
import { MAIL_OPTIONS } from './mail-options';
import type { MailOptions } from './mail-options';

const addEntrySchema = z.object({
  kind: z.enum(['address', 'domain']),
  value: z.string().min(1).max(320),
  note: z.string().max(500).optional().nullable(),
});

/**
 * /api/email — the owner's Email capture surface (Session O4, decision 0028):
 * the inbound address (read-only), the sender allowlist (view/add/remove,
 * audited), and recent refusals for one-click allowlisting. The forwarding-setup
 * guidance that accompanies the address is Unit B; this ships the address +
 * allowlist controls.
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
    const [allowlist, recentRefusals] = await Promise.all([
      this.allowlist.listForOwner(request.principal.userId),
      this.allowlist.recentRefusalsForOwner(request.principal.userId),
    ]);
    return {
      inboundAddress: this.options.inboundAddress,
      // The caller's own address is implicitly trusted (decision 0031 rule 1).
      selfAddress: request.principal.email ?? null,
      allowlist,
      recentRefusals,
    };
  }

  @Post('allowlist')
  async addEntry(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<EmailAllowlistEntryDto> {
    const parsed = addEntrySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.allowlist.addEntry(request.principal, parsed.data);
  }

  @Delete('allowlist/:id')
  @HttpCode(204)
  async removeEntry(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    const removed = await this.allowlist.removeEntry(request.principal, id);
    if (!removed) throw new NotFoundException('allowlist entry not found');
  }
}
