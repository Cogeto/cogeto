import { Module } from '@nestjs/common';
import { UserContextModule } from '../infrastructure/index';
import { MemoryModule } from '../memory/index';
import { ChatController } from './chat/chat.controller';
import { ChatService } from './chat/chat.service';
import { RetrievalService } from './retrieval.service';

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
  providers: [RetrievalService, ChatService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
