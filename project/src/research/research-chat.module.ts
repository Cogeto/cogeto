import { Global, Module } from '@nestjs/common';
import {
  DEFAULT_INSTANCE_TIMEZONE,
  INSTANCE_TIMEZONE,
  UserContextModule,
  UserContextService,
} from '../infrastructure/index';
import {
  CHAT_RESEARCH_RESOLVER,
  ChatSourceModule,
  CONVERSATION_APPEND,
  RetrievalModule,
  RetrievalService,
} from '../retrieval/index';
import type { ConversationAppendPort } from '../retrieval/index';
import { ChatResearchResolver } from './chat-research-resolver';
import { ResearchRunController } from './research-run.controller';
import { RESEARCH_SYNTHESIS_OPTIONS, ResearchSynthesisService } from './research-synthesis.service';
import type { ResearchSynthesisOptions } from './research-synthesis.service';

/**
 * The research flow's app-only composition — the mirror of
 * EmailReplyModule: needs RetrievalService (synthesis) and binds the chat →
 * research seam, so it is composed ONLY into the app root, never the worker
 * (whose research intent stays inert).
 *
 * RECORDED EXCEPTION B15 (docs/module-boundary-contract.md): still global, for
 * exactly one reason — ChatService lives in RetrievalModule and must resolve
 * CHAT_RESEARCH_RESOLVER, which this module binds, and it cannot import this
 * module because this module already imports it. Un-globaling it today would
 * silently null an @Optional() argument and drop research from chat with every
 * test still green. V2.0 item 3.6 part 4 moves chat out of RetrievalModule and
 * binds the handlers at the composition root, which removes the reason.
 */
@Global()
@Module({
  // ChatSourceModule (the conversation-append seam) and UserContextModule are
  // explicit since they stopped being global: ResearchSynthesisService injects
  // CONVERSATION_APPEND and UserContextService, both @Optional().
  imports: [RetrievalModule, ChatSourceModule, UserContextModule],
  controllers: [ResearchRunController],
  providers: [
    ChatResearchResolver,
    ResearchSynthesisService,
    // The synthesis collaborators, by TOKEN into a named bag (V2.0 item 3.6
    // part 4). The APP composition always has retrieval; the factory asserts
    // it so a wiring regression fails boot instead of silently degrading the
    // app's synthesis to web-only citations.
    {
      provide: RESEARCH_SYNTHESIS_OPTIONS,
      useFactory: (
        retrieval: RetrievalService,
        userContext: UserContextService,
        conversationAppend: ConversationAppendPort,
        timeZone?: string,
      ): ResearchSynthesisOptions => {
        if (!retrieval || !userContext || !conversationAppend) {
          throw new Error(
            'ResearchChatModule: synthesis wiring incomplete (retrieval/userContext/conversationAppend)',
          );
        }
        return {
          retrieval,
          userContext,
          conversationAppend,
          instanceTimeZone: timeZone ?? DEFAULT_INSTANCE_TIMEZONE,
        };
      },
      inject: [
        RetrievalService,
        UserContextService,
        CONVERSATION_APPEND,
        { token: INSTANCE_TIMEZONE, optional: true },
      ],
    },
    { provide: CHAT_RESEARCH_RESOLVER, useExisting: ChatResearchResolver },
  ],
  exports: [CHAT_RESEARCH_RESOLVER, ResearchSynthesisService],
})
export class ResearchChatModule {}
