import { Module } from '@nestjs/common';
import {
  DEFAULT_INSTANCE_TIMEZONE,
  DRIZZLE,
  INSTANCE_TIMEZONE,
  UserContextModule,
  UserContextService,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { MemoryModule } from '../memory/index';
import { ChatController } from './chat/chat.controller';
import { CHAT_SERVICE_OPTIONS, ChatService } from './chat/chat.service';
import type { ChatServiceOptions } from './chat/chat.service';
import { CHAT_REPLY_RESOLVER } from './chat/chat-reply-resolver.port';
import type { ChatReplyResolverPort } from './chat/chat-reply-resolver.port';
import { CHAT_RESEARCH_RESOLVER } from './chat/chat-research-resolver.port';
import type { ChatResearchResolverPort } from './chat/chat-research-resolver.port';
import { CHAT_SKILL_RESOLVER } from './chat/chat-skill-resolver.port';
import type { ChatSkillResolverPort } from './chat/chat-skill-resolver.port';
import { RETRIEVAL_SERVICE_OPTIONS, RetrievalService } from './retrieval.service';
import type { RetrievalServiceOptions } from './retrieval.service';

/**
 * retrieval — hybrid, fused, filtered search (spec §3.4) plus the chat
 * area. Composes the memory module's Principal-gated search primitives
 *, including the open-loops read behind the day-one
 * question; owns chat_message; everything here is fast path.
 */
@Module({
  // UserContextModule: ChatService's per-user context and language preference.
  // Explicit since it stopped being global (boundary contract §4).
  imports: [MemoryModule, UserContextModule],
  controllers: [ChatController],
  providers: [
    RetrievalService,
    ChatService,
    // The optional collaborators of both services, resolved BY TOKEN into one
    // named options object each (V2.0 item 3.6 part 4): identity, never
    // position. Each entry is optional so bare compositions still boot; the
    // APP root additionally asserts chat's full wiring at startup.
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
    {
      provide: RETRIEVAL_SERVICE_OPTIONS,
      useFactory: (db?: Db, timeZone?: string): RetrievalServiceOptions => ({
        db,
        timeZone: timeZone ?? DEFAULT_INSTANCE_TIMEZONE,
      }),
      inject: [
        { token: DRIZZLE, optional: true },
        { token: INSTANCE_TIMEZONE, optional: true },
      ],
    },
  ],
  // ChatService is exported for exactly one consumer: the app composition
  // root's boot assertion that every chat seam is wired (assertFullyWired).
  exports: [RetrievalService, ChatService],
})
export class RetrievalModule {}
