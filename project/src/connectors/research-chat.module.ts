import { Global, Module } from '@nestjs/common';
import { UserContextModule } from '../infrastructure/index';
import { CHAT_RESEARCH_RESOLVER, ChatSourceModule, RetrievalModule } from '../retrieval/index';
import { ChatResearchResolver } from './chat-research-resolver';
import { ResearchRunController } from './research-run.controller';
import { ResearchSynthesisService } from './research-synthesis.service';

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
    { provide: CHAT_RESEARCH_RESOLVER, useExisting: ChatResearchResolver },
  ],
  exports: [CHAT_RESEARCH_RESOLVER, ResearchSynthesisService],
})
export class ResearchChatModule {}
