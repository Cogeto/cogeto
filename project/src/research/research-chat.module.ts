import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import {
  DEFAULT_INSTANCE_TIMEZONE,
  INSTANCE_TIMEZONE,
  UserContextModule,
  UserContextService,
} from '../infrastructure/index';
import { RetrievalService } from '../retrieval/index';
import { CHAT_RESEARCH_RESOLVER, ChatSourceModule, CONVERSATION_APPEND } from '../chat/index';
import type { ConversationAppendPort } from '../chat/index';
import { ChatResearchResolver } from './chat-research-resolver';
import { ResearchRunController } from './research-run.controller';
import { RESEARCH_SYNTHESIS_OPTIONS, ResearchSynthesisService } from './research-synthesis.service';
import type { ResearchSynthesisOptions } from './research-synthesis.service';

/**
 * The research flow's app-only composition — the mirror of EmailReplyModule:
 * needs RetrievalService (synthesis) and binds the chat → research seam, so
 * it is composed ONLY into the app root, never the worker (whose research
 * intent stays inert). `imports` receives the research family instance whose
 * ResearchService the resolver and synthesis inject.
 *
 * NOT global since B15 closed (V2.0 item 3.6 part 4): the app root passes
 * this instance into ChatModule.register, whose options factory resolves
 * CHAT_RESEARCH_RESOLVER by token, and the boot assertion proves the seam
 * took.
 */
@Module({})
export class ResearchChatModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: ResearchChatModule,
      // ChatSourceModule (the conversation-append seam) and UserContextModule
      // are explicit: ResearchSynthesisService resolves CONVERSATION_APPEND
      // and UserContextService from them.
      imports: [ChatSourceModule, UserContextModule, ...(options.imports ?? [])],
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
    };
  }
}
