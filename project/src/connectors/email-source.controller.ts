import { Controller, Get, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import type { EmailSourceDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { EmailSourceService } from './email-source.service';

/**
 * GET /api/email/:id/source (Session O4 — email reply triggers): the email
 * reading view behind an email memory's source drawer — the full retained
 * message (sender, recipients, subject, body, attachments) plus the recovered
 * original correspondent for a forward. Owner-only.
 */
@Controller('email')
@UseGuards(BearerAuthGuard)
export class EmailSourceController {
  constructor(private readonly emails: EmailSourceService) {}

  @Get(':id/source')
  async source(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<EmailSourceDto> {
    const view = await this.emails.getSourceForOwner(request.principal, id);
    if (!view) throw new NotFoundException(`email ${id} not found`);
    return view;
  }
}
