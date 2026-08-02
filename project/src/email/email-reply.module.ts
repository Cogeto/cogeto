import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { AgentsModule } from '../agents/index';
import { RetrievalModule } from '../retrieval/index';
import { CHAT_REPLY_RESOLVER } from '../chat/index';
import { EmailReplyDraftService } from './email-reply-draft.service';
import { EmailReplyController } from './email-reply.controller';
import { ChatReplyResolver } from './chat-reply-resolver';

/**
 * The reply-drafting composition. Groups the app-only reply pieces — the
 * drafter, its HTTP endpoint, and the chat → reply resolver — and imports the
 * modules they need (RetrievalService for context, ApprovalService for the
 * approval path, the email family instance via `imports` for the retained
 * sources). Registered ONLY in the app composition root; the worker never
 * drafts replies.
 *
 * NOT global since B15 closed (V2.0 item 3.6 part 4): the app root passes
 * this instance into ChatModule.register, whose options factory resolves
 * CHAT_REPLY_RESOLVER by token, and the boot assertion proves the seam took.
 */
@Module({})
export class EmailReplyModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: EmailReplyModule,
      imports: [RetrievalModule, AgentsModule, ...(options.imports ?? [])],
      controllers: [EmailReplyController],
      providers: [
        EmailReplyDraftService,
        ChatReplyResolver,
        { provide: CHAT_REPLY_RESOLVER, useExisting: ChatReplyResolver },
      ],
      exports: [EmailReplyDraftService, CHAT_REPLY_RESOLVER],
    };
  }
}
