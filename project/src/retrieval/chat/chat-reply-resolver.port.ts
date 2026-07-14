import type { Principal } from '@cogeto/shared';

/**
 * The chat → email-reply seam (Session O4 — email reply triggers). Chat detects
 * a "draft a reply to Ana" request (query-understanding), but the email data and
 * the drafting live in connectors (app-only). This port lets ChatService resolve
 * the target email and create the draft without importing connectors — the
 * memory module's SourceReader/SourceDeletion pattern: retrieval defines the
 * port, connectors implements it, the app composition root binds it. Optional in
 * ChatService, so the worker and bare test harnesses run without it.
 */

export interface ChatReplyCandidate {
  emailId: string;
  from: string;
  subject: string | null;
  receivedAt: string;
}

export interface ChatReplyDraftResult {
  approvalId: string;
  /** False when the recipient could not be recovered (forwarded-addressing). */
  recipientResolved: boolean;
  to: string;
}

export interface ChatReplyResolverPort {
  /** Recent emails matching a named person/sender (null → most recent). */
  findCandidates(principal: Principal, name: string | null): Promise<ChatReplyCandidate[]>;
  /** Create the reply draft for a resolved email (delegates to the drafter). */
  createDraft(principal: Principal, emailId: string): Promise<ChatReplyDraftResult>;
}

export const CHAT_REPLY_RESOLVER = Symbol('CHAT_REPLY_RESOLVER');
