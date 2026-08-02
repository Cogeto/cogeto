import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import {
  DEFAULT_INSTANCE_TIMEZONE,
  INSTANCE_TIMEZONE,
  UserContextModule,
  UserContextService,
} from '../infrastructure/index';
import { ChatController } from './chat.controller';
import { CHAT_SERVICE_OPTIONS, ChatService } from './chat.service';
import type { ChatServiceOptions } from './chat.service';
import { CHAT_REPLY_RESOLVER } from './chat-reply-resolver.port';
import type { ChatReplyResolverPort } from './chat-reply-resolver.port';
import { CHAT_RESEARCH_RESOLVER } from './chat-research-resolver.port';
import type { ChatResearchResolverPort } from './chat-research-resolver.port';
import { CHAT_SKILL_RESOLVER } from './chat-skill-resolver.port';
import type { ChatSkillResolverPort } from './chat-skill-resolver.port';

/**
 * chat — the conversation surface, and a capture connector by structure
 * (V2.0 item 3.6 part 4, moved out of retrieval): it owns chat_message and
 * conversation, captures sources through "remember this", and implements the
 * reader/deletion ports like every other connector family. Asking stays
 * strictly fast path.
 *
 * `imports` receives the modules that BIND the three resolver ports (reply
 * drafting, research, skills) — passed explicitly by the app composition
 * root. That threading is what let those modules stop being global (B15):
 * the options factory below resolves each port BY TOKEN from these imports,
 * and the app root asserts full wiring at boot.
 */
@Module({})
export class ChatModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: ChatModule,
      imports: [UserContextModule, ...(options.imports ?? [])],
      controllers: [ChatController],
      providers: [
        ChatService,
        {
          provide: CHAT_SERVICE_OPTIONS,
          useFactory: (
            replyResolver?: ChatReplyResolverPort,
            researchResolver?: ChatResearchResolverPort,
            skillResolver?: ChatSkillResolverPort,
            timeZone?: string,
            userContext?: UserContextService,
          ): ChatServiceOptions => ({
            replyResolver,
            researchResolver,
            skillResolver,
            timeZone: timeZone ?? DEFAULT_INSTANCE_TIMEZONE,
            userContext,
          }),
          inject: [
            { token: CHAT_REPLY_RESOLVER, optional: true },
            { token: CHAT_RESEARCH_RESOLVER, optional: true },
            { token: CHAT_SKILL_RESOLVER, optional: true },
            { token: INSTANCE_TIMEZONE, optional: true },
            { token: UserContextService, optional: true },
          ],
        },
      ],
      // ChatService is exported for exactly one consumer: the app root's boot
      // assertion that every chat seam is wired (assertFullyWired).
      exports: [ChatService],
    };
  }
}
