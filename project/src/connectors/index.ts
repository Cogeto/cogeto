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
export { EmailAllowlistService } from './email-allowlist.service';
export { EmailSourceReader } from './email.source-reader';
export { EmailSourceDeletion } from './email.source-deletion';
// Reply drafting (Session O4) — composed ONLY into the app root (needs
// RetrievalService + ApprovalService); never the worker.
export { EmailReplyDraftService } from './email-reply-draft.service';
export { EmailReplyController } from './email-reply.controller';
export { MAIL_OPTIONS } from './mail-options';
export type { MailOptions } from './mail-options';
