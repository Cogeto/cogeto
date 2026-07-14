import { Global, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/index';
import { RetrievalModule, CHAT_REPLY_RESOLVER } from '../retrieval/index';
import { EmailReplyDraftService } from './email-reply-draft.service';
import { EmailReplyController } from './email-reply.controller';
import { ChatReplyResolver } from './chat-reply-resolver';

/**
 * The reply-drafting composition (Session O4 — email reply triggers). Groups the
 * app-only reply pieces — the drafter, its HTTP endpoint, and the chat → reply
 * resolver — and imports the modules they need (RetrievalService for context,
 * ApprovalService for the approval path).
 *
 * Marked GLOBAL so the CHAT_REPLY_RESOLVER token it binds is visible to
 * ChatService (in RetrievalModule) without a module-level cycle — the same way
 * MemoryModule/ModelGatewayModule expose their seams. Registered ONLY in the app
 * composition root; the worker never drafts replies.
 */
@Global()
@Module({
  imports: [RetrievalModule, AgentsModule],
  controllers: [EmailReplyController],
  providers: [
    EmailReplyDraftService,
    ChatReplyResolver,
    { provide: CHAT_REPLY_RESOLVER, useExisting: ChatReplyResolver },
  ],
  exports: [EmailReplyDraftService, CHAT_REPLY_RESOLVER],
})
export class EmailReplyModule {}
