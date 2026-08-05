/**
 * chat — the conversation surface and capture connector (V2.0 item 3.6
 * part 4, moved out of retrieval). Owns chat_message + conversation, the
 * three resolver seams (reply drafting, research, skills), the source ports,
 * and the conversation auto-titler.
 */
export { ChatModule } from './chat.module';
export { CHAT_SERVICE_OPTIONS, ChatService } from './chat.service';
export { ANSWER_PROMPT, buildAnswerInput } from './answer-prompt';
export { CHAT_REPLY_RESOLVER } from './chat-reply-resolver.port';
export type {
  ChatReplyResolverPort,
  ChatReplyCandidate,
  ChatReplyDraftResult,
} from './chat-reply-resolver.port';
export { CHAT_RESEARCH_RESOLVER } from './chat-research-resolver.port';
export type { ChatResearchResolverPort, ChatResearchProposal } from './chat-research-resolver.port';
export { CHAT_SKILL_RESOLVER } from './chat-skill-resolver.port';
export type { ChatSkillResolverPort, ChatSkillProposal } from './chat-skill-resolver.port';
export { ChatSourceModule } from './chat-source.module';
export { ChatSourceReader } from './chat.source-reader';
export { ChatSourceDeletion } from './chat.source-deletion';
export { ConversationSourceDeletion } from './conversation.source-deletion';
export {
  CONVERSATION_TITLE_JOB_TYPE,
  CONVERSATION_TITLE_PROMPT,
  ConversationTitler,
} from './conversation-titler';
export { CONVERSATION_APPEND, ConversationScribe } from './conversation-scribe';
export type { ConversationAppendPort } from './conversation-scribe';
export { ChatAnswerCascade } from './chat-answer-cascade';
// Conversation attachments (V2.2 item 5.1): the transient read job + its
// worker module, and the deletion cascade that erases attachment rows with
// their conversation and clears links to an erased file source.
export {
  CHAT_ATTACHMENT_READ_JOB_TYPE,
  ChatAttachmentReadService,
  ChatAttachmentWorkerModule,
} from './attachment-read';
export { ChatAttachmentCascade } from './chat-attachment-cascade';
