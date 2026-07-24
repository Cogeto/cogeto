/** Public interface of the connectors bounded context (§A.1 rule 1). */
export { ConnectorsModule } from './connectors.module';
export type { ConnectorsModuleOptions } from './connectors.module';
export { NotesService } from './notes.service';
export { NotesSourceReader } from './notes.source-reader';
export { NotesSourceDeletion } from './notes.source-deletion';
export { FilesService } from './files.service';
export { FileSourceReader } from './file.source-reader';
export { UserSettingsService } from './user-settings.service';
export { FILE_UPLOAD_OPTIONS } from './file-upload-options';
export type { FileUploadOptions } from './file-upload-options';
export {
  extractDocumentText,
  sniffContentType,
  PermanentExtractionError,
} from './document-extract';
// Inbound email (Session O4, decision 0028).
export { EmailIntakeService } from './email-intake.service';
export type { MailEnvelope, IntakeResult } from './email-intake.service';
export {
  EmailAllowlistService,
  EMAIL_REFUSAL_RETENTION_JOB_TYPE,
  EMAIL_REFUSAL_RETENTION_CRONTAB,
} from './email-allowlist.service';
export { EmailSourceReader } from './email.source-reader';
export { EmailSourceDeletion } from './email.source-deletion';
export { EmailSourceService } from './email-source.service';
export { resolveReplyTarget, replySubject } from './email-reply-target';
export type { ReplyTarget, ReplyTargetSource } from './email-reply-target';
// Reply drafting + chat resolver (Session O4) — composed ONLY into the app root
// (needs RetrievalService + ApprovalService); never the worker.
export { EmailReplyDraftService } from './email-reply-draft.service';
export { EmailReplyController } from './email-reply.controller';
export { ChatReplyResolver } from './chat-reply-resolver';
export { EmailReplyModule } from './email-reply.module';
export { MAIL_OPTIONS } from './mail-options';
export type { MailOptions } from './mail-options';
// Web research (Priority 5 Part A, decisions 0042/0043).
export { ResearchService } from './research.service';
// Part B (decisions 0044/0045): minimisation, the gate, chat seam, synthesis —
// ResearchChatModule is composed ONLY into the app root (needs retrieval).
export { minimiseQuery, RESEARCH_MINIMISE_PROMPT } from './research-minimise';
export type { MinimisedQuery } from './research-minimise';
export { ChatResearchResolver } from './chat-research-resolver';
export { ResearchSynthesisService, RESEARCH_ANSWER_PROMPT } from './research-synthesis.service';
export { UserContextController } from './user-context.controller';
export {
  ContextSuggestionsService,
  CONTEXT_SUGGEST_PROMPT,
  deriveCandidate,
} from './context-suggestions.service';
export { ResearchChatModule } from './research-chat.module';
export { WebDiscoveryService } from './web-discovery.service';
export type { DiscoveryOutcome, DiscoveredPage } from './web-discovery.service';
export { WebFetchService, isPrivateAddress, robotsAllows } from './web-fetch';
export type { FetchOutcome, FetchedPage } from './web-fetch';
export { WebSourceReader } from './web.source-reader';
export { WebSourceDeletion } from './web.source-deletion';
export { RESEARCH_OPTIONS } from './research-options';
export type { ResearchOptions } from './research-options';
