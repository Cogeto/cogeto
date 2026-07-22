import { Global, Module } from '@nestjs/common';
import { CHAT_RESEARCH_RESOLVER, RetrievalModule } from '../retrieval/index';
import { ChatResearchResolver } from './chat-research-resolver';
import { ResearchRunController } from './research-run.controller';
import { ResearchSynthesisService } from './research-synthesis.service';

/**
 * The research flow's app-only composition (Priority 5 Part B) — the mirror of
 * EmailReplyModule: needs RetrievalService (synthesis) and binds the chat →
 * research seam, so it is composed ONLY into the app root, never the worker
 * (whose research intent stays inert). Global so ChatService resolves
 * CHAT_RESEARCH_RESOLVER without importing connectors.
 */
@Global()
@Module({
  imports: [RetrievalModule],
  controllers: [ResearchRunController],
  providers: [
    ChatResearchResolver,
    ResearchSynthesisService,
    { provide: CHAT_RESEARCH_RESOLVER, useExisting: ChatResearchResolver },
  ],
  exports: [CHAT_RESEARCH_RESOLVER, ResearchSynthesisService],
})
export class ResearchChatModule {}
