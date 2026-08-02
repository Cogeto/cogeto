import { Global, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/index';
import { RetrievalModule, CHAT_REPLY_RESOLVER } from '../retrieval/index';
import { EmailReplyDraftService } from './email-reply-draft.service';
import { EmailReplyController } from './email-reply.controller';
import { ChatReplyResolver } from './chat-reply-resolver';

/**
 * The reply-drafting composition. Groups the
 * app-only reply pieces — the drafter, its HTTP endpoint, and the chat → reply
 * resolver — and imports the modules they need (RetrievalService for context,
 * ApprovalService for the approval path).
 *
 * RECORDED EXCEPTION B15 (docs/module-boundary-contract.md): marked GLOBAL so
 * the CHAT_REPLY_RESOLVER token it binds is visible to ChatService (in
 * RetrievalModule) without a module-level cycle — this module already imports
 * RetrievalModule, so ChatService cannot import back. Un-globaling it today
 * would silently null an @Optional() argument and drop reply drafting from chat
 * with every test still green. V2.0 item 3.6 part 4 moves chat out of
 * RetrievalModule and binds the handlers at the composition root, which removes
 * the reason. Registered ONLY in the app composition root; the worker never
 * drafts replies.
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
