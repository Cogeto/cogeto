/**
 * Public interface of the retrieval bounded context (§A.1 rule 1).
 * One read API: retrieve(principal, query, opts) on RetrievalService.
 */
export { RetrievalModule } from './retrieval.module';
export { RetrievalService } from './retrieval.service';
export type {
  RetrieveOptions,
  RetrievedMemory,
  RetrievalResult,
  RetrievalMode,
} from './retrieval.service';
export type { ConversationTurn } from './query-rewrite';
export { QUERY_REWRITE_PROMPT } from './query-rewrite';
export type { RetrievalSignal } from './fusion';
// The chat area's service + prompt ref (worker registers the prompt on boot, §B.7).
// ChatService is exposed for composition roots (the eval harness); the HTTP
// surface stays the ChatController.
export { ChatService } from './chat/chat.service';
export { ANSWER_PROMPT } from './chat/answer-prompt';
