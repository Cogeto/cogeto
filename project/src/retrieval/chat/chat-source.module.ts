import { Global, Module } from '@nestjs/common';
import { ChatSourceReader } from './chat.source-reader';
import { ChatSourceDeletion } from './chat.source-deletion';
import { ChatAnswerCascade } from './chat-answer-cascade';

/**
 * The chat source ports (decision 0021) as a GLOBAL slim module: the pipeline
 * reader and the deletion adapter for source_type 'chat'. Global + standalone
 * (DRIZZLE only) so BOTH composition roots resolve them — the worker binds the
 * reader into ingestion's SOURCE_READERS and the deletion into the memory saga,
 * the app binds the deletion for the source-delete endpoint — without pulling
 * the full RetrievalModule (ChatService, RetrievalService) into the worker.
 * Mirrors the connectors seam's global source ports. Each composition root is a
 * separate Nest application, so importing it once per root is not a double
 * provision.
 */
@Global()
@Module({
  providers: [ChatSourceReader, ChatSourceDeletion, ChatAnswerCascade],
  exports: [ChatSourceReader, ChatSourceDeletion, ChatAnswerCascade],
})
export class ChatSourceModule {}
