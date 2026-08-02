/**
 * Public interface of the retrieval bounded context (spec §15 rule 1).
 * One read API: retrieve(principal, query, opts) on RetrievalService.
 */
export { RetrievalModule } from './retrieval.module';
export { RETRIEVAL_SERVICE_OPTIONS, RetrievalService } from './retrieval.service';
export type { RetrievalServiceOptions } from './retrieval.service';
export type {
  RetrieveOptions,
  RetrievedMemory,
  RetrievalResult,
  RetrievalMode,
  OpenLoop,
} from './retrieval.service';
export type { ConversationTurn } from './query-rewrite';
export {
  QUERY_REWRITE_PROMPT,
  detectEmailReplyIntent,
  detectResearchIntent,
  REPLY_EMAIL_HINT_RE,
} from './query-rewrite';
export type { EmailReplyIntent, ResearchIntent } from './query-rewrite';
// The chat → research seam: same pattern as the reply seam.
export { CHAT_RESEARCH_RESOLVER } from './chat/chat-research-resolver.port';
export type {
  ChatResearchResolverPort,
  ChatResearchProposal,
} from './chat/chat-research-resolver.port';
// The chat → skill seam: same pattern again.
export { CHAT_SKILL_RESOLVER } from './chat/chat-skill-resolver.port';
export type { ChatSkillResolverPort, ChatSkillProposal } from './chat/chat-skill-resolver.port';
export { detectSkillBriefIntent } from './query-rewrite';
export type { SkillBriefIntent } from './query-rewrite';
// The query-rewrite eval suite (V2.0 item 3.4): exposed for the eval
// entrypoint, the same way ingestion exposes its golden-set harness.
export {
  runRewriteEval,
  loadRewriteCases,
  rewriteCaseSchema,
  scoreRewriteCase,
} from './eval-rewrite';
export type { RewriteCase, RewriteEvalMetrics, RewriteEvalResult } from './eval-rewrite';
// The chat → email-reply seam: retrieval defines the port,
// connectors implements it, the app root binds it (like the SourceReader family).
export { CHAT_REPLY_RESOLVER } from './chat/chat-reply-resolver.port';
export type {
  ChatReplyResolverPort,
  ChatReplyCandidate,
  ChatReplyDraftResult,
} from './chat/chat-reply-resolver.port';
export type { RetrievalSignal } from './fusion';
// The chat area's service + prompt ref (worker registers the prompt on boot, spec §12.3).
// ChatService is exposed for composition roots (the eval harness); the HTTP
// surface stays the ChatController.
export { CHAT_SERVICE_OPTIONS, ChatService } from './chat/chat.service';
export type { ChatServiceOptions } from './chat/chat.service';
export { ANSWER_PROMPT } from './chat/answer-prompt';
// The chat source ports for source_type 'chat': the composition
// roots bind these into ingestion's readers and the memory deletion saga.
export { ChatSourceModule } from './chat/chat-source.module';
export { ChatSourceReader } from './chat/chat.source-reader';
export { ChatSourceDeletion } from './chat/chat.source-deletion';
// conversation containers — the 'chat_conversation'
// deletion adapter and the worker's auto-title job.
export { ConversationSourceDeletion } from './chat/conversation.source-deletion';
export {
  ConversationTitler,
  CONVERSATION_TITLE_JOB_TYPE,
  CONVERSATION_TITLE_PROMPT,
  sanitizeTitle,
} from './chat/conversation-titler';
// The conversation-append seam: research answers
// land in the conversation they were invoked from. Retrieval owns port + impl.
export { CONVERSATION_APPEND, ConversationScribe } from './chat/conversation-scribe';
export type { ConversationAppendPort } from './chat/conversation-scribe';
// the deletion saga's cascade over assistant answers
// that cite erased memories — bound into MemoryModule's derivedCascades.
export { ChatAnswerCascade, CHAT_ANSWER_REDACTED } from './chat/chat-answer-cascade';
