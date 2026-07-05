import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/index';
import { TasksModule } from '../tasks/index';
import { ChatController } from './chat/chat.controller';
import { ChatService } from './chat/chat.service';
import { RetrievalService } from './retrieval.service';

/**
 * retrieval — hybrid, fused, filtered search (Addendum §A.5) plus the chat
 * area (S3-A). Composes the memory module's Principal-gated search primitives
 * (decision 0003 ruling 2) and, for the open-loops answer (F3-B), the task
 * engine's owner-scoped reads; owns chat_message; everything here is fast
 * path — the tasks LIST is a read, derivation stays in the worker.
 */
@Module({
  imports: [MemoryModule, TasksModule.register()],
  controllers: [ChatController],
  providers: [RetrievalService, ChatService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
