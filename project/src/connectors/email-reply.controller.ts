import { Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { ApprovalDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { EmailReplyDraftService } from './email-reply-draft.service';

/**
 * POST /api/email/:id/reply-draft (Session O4 — email source): draft a reply to
 * an email the caller owns. The draft is created as an `email_reply_draft`
 * approval (consequential action) — Cogeto never sends; on approval the draft is
 * finalised and presented for the user to send from their own client. This is
 * the entry the chat/email UI calls for "draft a reply to Ana's last message".
 *
 * Registered ONLY in the app composition root (it needs RetrievalService +
 * ApprovalService), never the worker.
 */
@Controller('email')
@UseGuards(BearerAuthGuard)
export class EmailReplyController {
  constructor(private readonly drafts: EmailReplyDraftService) {}

  @Post(':id/reply-draft')
  async draftReply(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<ApprovalDto> {
    return this.drafts.draftReply(request.principal, id);
  }
}
