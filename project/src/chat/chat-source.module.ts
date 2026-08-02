import { Module } from '@nestjs/common';
import { SettingsPortsModule } from '../settings/index';
import { ChatSourceReader } from './chat.source-reader';
import { ChatSourceDeletion } from './chat.source-deletion';
import { ChatAnswerCascade } from './chat-answer-cascade';
import { ConversationSourceDeletion } from './conversation.source-deletion';
import { ConversationTitler } from './conversation-titler';
import { CONVERSATION_APPEND, ConversationScribe } from './conversation-scribe';

/**
 * The chat source ports as a slim standalone module: the pipeline reader and
 * the deletion adapters for source_type 'chat' and 'chat_conversation', plus
 * the conversation auto-titler the worker's `conversation.title` job runs.
 * Standalone (its providers need only the global DRIZZLE and ModelGateway) so
 * the worker can bind chat's ports without pulling the full RetrievalModule
 * (ChatService, RetrievalService) into that process.
 *
 * **Not global** (V2.0 item 3.6, `docs/module-boundary-contract.md` §4). It was,
 * which is why nothing declared where these ports were bound. They are now
 * passed explicitly: `IngestionModule.register({ imports })` for the reader,
 * `MemoryModule.register({ sourceDeletions.imports, derivedCascades.imports })`
 * for the deletion and cascade adapters, and `ResearchChatModule` for the
 * conversation-append seam. Each composition root is a separate Nest
 * application, so importing it once per root is not a double provision.
 */
@Module({
  // The slim settings port, for the reader's capture-scope stamp (V2.0 item
  // 3.7). Deliberately the PORTS module and not SettingsModule: memory imports
  // this module through its registration options and SettingsModule imports
  // memory, so the full module here would be a cycle.
  imports: [SettingsPortsModule],
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
