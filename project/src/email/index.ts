/**
 * email — inbound mail capture and reply drafting (V2.0 item 3.6 part 4,
 * split out of connectors): the intake endpoint the Haraka forwarder POSTs
 * to, thread-aware parsing, the sender allowlist and refusal ledger, retained
 * sources, and the app-only reply-draft composition with chat's reply seam.
 */
export { EmailModule } from './email.module';
export { EmailIntakeService } from './email-intake.service';
export {
  EmailAllowlistService,
  EMAIL_REFUSAL_RETENTION_JOB_TYPE,
  EMAIL_REFUSAL_RETENTION_CRONTAB,
} from './email-allowlist.service';
export { EmailSourceReader } from './email.source-reader';
export { EmailSourceDeletion } from './email.source-deletion';
export { EmailSourceService } from './email-source.service';
// Reply drafting + chat resolver — composed ONLY into the app root
// (needs RetrievalService + ApprovalService); never the worker.
export { EmailReplyDraftService } from './email-reply-draft.service';
export { ChatReplyResolver } from './chat-reply-resolver';
export { EmailReplyModule } from './email-reply.module';
export { MAIL_OPTIONS } from './mail-options';
// The generic HTML sanitizer (DOMPurify, SEC-13 posture) other capture
// families reuse on retained markup.
export { sanitizeHtml } from './email-parse';
export { EmailSourcePortsModule } from './email-source-ports.module';
// Space deletion's email-routing leg (docs/features/spaces.md section 6c).
export { EmailRoutingSpaceCleanup, EmailRoutingSpaceCleanupModule } from './email-space-cleanup';

// The source catalog's email listing (V2.2 item 5.2).
export { listEmailSources, hydrateEmailSources, countEmailSources } from './source-listing';
