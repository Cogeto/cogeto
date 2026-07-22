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
export {
  QUERY_REWRITE_PROMPT,
  detectEmailReplyIntent,
  detectResearchIntent,
  REPLY_EMAIL_HINT_RE,
} from './query-rewrite';
export type { EmailReplyIntent, ResearchIntent } from './query-rewrite';
// The chat → research seam (Priority 5 Part B): same pattern as the reply seam.
export { CHAT_RESEARCH_RESOLVER } from './chat/chat-research-resolver.port';
export type {
  ChatResearchResolverPort,
  ChatResearchProposal,
} from './chat/chat-research-resolver.port';
// The chat → email-reply seam (Session O4): retrieval defines the port,
// connectors implements it, the app root binds it (like the SourceReader family).
export { CHAT_REPLY_RESOLVER } from './chat/chat-reply-resolver.port';
export type {
  ChatReplyResolverPort,
  ChatReplyCandidate,
  ChatReplyDraftResult,
} from './chat/chat-reply-resolver.port';
export type { RetrievalSignal } from './fusion';
// The chat area's service + prompt ref (worker registers the prompt on boot, §B.7).
// ChatService is exposed for composition roots (the eval harness); the HTTP
// surface stays the ChatController.
export { ChatService } from './chat/chat.service';
export { ANSWER_PROMPT } from './chat/answer-prompt';
// The chat source ports for source_type 'chat' (decision 0021): the composition
// roots bind these into ingestion's readers and the memory deletion saga.
export { ChatSourceModule } from './chat/chat-source.module';
export { ChatSourceReader } from './chat/chat.source-reader';
export { ChatSourceDeletion } from './chat/chat.source-deletion';
// QS-7 (decision 0025): the deletion saga's cascade over assistant answers
// that cite erased memories — bound into MemoryModule's derivedCascades.
export { ChatAnswerCascade, CHAT_ANSWER_REDACTED } from './chat/chat-answer-cascade';
