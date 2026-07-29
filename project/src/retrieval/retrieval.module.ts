import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/index';
import { ChatController } from './chat/chat.controller';
import { ChatService } from './chat/chat.service';
import { RetrievalService } from './retrieval.service';

/**
 * retrieval — hybrid, fused, filtered search (Addendum §A.5) plus the chat
 * area. Composes the memory module's Principal-gated search primitives
 *, including the open-loops read behind the day-one
 * question; owns chat_message; everything here is fast path.
 */
@Module({
  imports: [MemoryModule],
  controllers: [ChatController],
  providers: [RetrievalService, ChatService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
