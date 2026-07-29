import { Global, Module } from '@nestjs/common';
import { ChatSourceReader } from './chat.source-reader';
import { ChatSourceDeletion } from './chat.source-deletion';
import { ChatAnswerCascade } from './chat-answer-cascade';
import { ConversationSourceDeletion } from './conversation.source-deletion';
import { ConversationTitler } from './conversation-titler';
import { CONVERSATION_APPEND, ConversationScribe } from './conversation-scribe';

/**
 * The chat source ports as a GLOBAL slim module: the pipeline
 * reader and the deletion adapters for source_type 'chat' and
 * 'chat_conversation', plus the conversation auto-titler the worker's
 * `conversation.title` job runs. Global + standalone (only the global DRIZZLE
 * and ModelGateway providers) so BOTH composition roots resolve them — the
 * worker binds the reader into ingestion's SOURCE_READERS and the deletions
 * into the memory saga, the app binds the deletions for the source-delete
 * endpoint — without pulling the full RetrievalModule (ChatService,
 * RetrievalService) into the worker. Mirrors the connectors seam's global
 * source ports. Each composition root is a separate Nest application, so
 * importing it once per root is not a double provision.
 */
@Global()
@Module({
  providers: [
    ChatSourceReader,
    ChatSourceDeletion,
    ConversationSourceDeletion,
    ChatAnswerCascade,
    ConversationTitler,
    ConversationScribe,
    // The conversation-append seam: research (connectors)
    // injects the token; retrieval owns the implementation and the tables.
    { provide: CONVERSATION_APPEND, useExisting: ConversationScribe },
  ],
  exports: [
    ChatSourceReader,
    ChatSourceDeletion,
    ConversationSourceDeletion,
    ChatAnswerCascade,
    ConversationTitler,
    ConversationScribe,
    CONVERSATION_APPEND,
  ],
})
export class ChatSourceModule {}
