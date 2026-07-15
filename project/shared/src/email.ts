import type { ApprovalStatus } from './approvals';
import type { MemoryScope } from './memory';

/** Inbound email DTOs (Session O4, decision 0028). */

/** An allowlist entry kind: a full address, or a whole domain. */
export type EmailAllowlistKind = 'address' | 'domain';

/** A sender-allowlist entry (the primary acceptance gate, decision 0028 ruling 2). */
export interface EmailAllowlistEntryDto {
  id: string;
  kind: EmailAllowlistKind;
  /** Normalized: lower-cased; domains are bare (no leading '@'). */
  value: string;
  note: string | null;
  createdAt: string;
}

/** Request body for adding an allowlist entry. */
export interface AddEmailAllowlistEntryRequest {
  kind: EmailAllowlistKind;
  value: string;
  note?: string | null;
}

/** A metadata-only record of refused mail (never a body) — decision 0028 ruling 7. */
export interface EmailRefusalDto {
  id: string;
  fromAddr: string | null;
  reason: string;
  refusedAt: string;
}

/**
 * GET /api/email/config — the Settings → Email capture surface: the instance's
 * inbound address, the caller's implicitly trusted own address, the current
 * allowlist, and recent refusals for one-click allowlisting.
 */
export interface EmailCaptureConfigDto {
  /** The instance's unique inbound address (decision 0028 ruling 1), or null
   * when the instance has not been configured with one yet. */
  inboundAddress: string | null;
  /** The caller's registered address — always trusted: mail they send or
   * forward to the inbound address is captured for them (decision 0031 rule 1).
   * Null when the identity token carries no email. */
  selfAddress: string | null;
  allowlist: EmailAllowlistEntryDto[];
  recentRefusals: EmailRefusalDto[];
}

/**
 * Reply drafts (Session O4 — email source). Drafting a reply is a CONSEQUENTIAL
 * action in the approval machine, but the effect is NOT sending: on approval the
 * draft is finalised and presented for the user to send from their own client.
 * Cogeto never sends mail.
 */
export const EMAIL_REPLY_DRAFT_ACTION = 'email.reply_draft';

/** The approval payload for a drafted reply (stored on the approval row). */
export interface EmailReplyDraftPayload {
  /** The recipient — the recovered original correspondent's address (see the
   * forwarded-addressing rule). Empty string when it could not be recovered. */
  to: string;
  /** Whether the recipient was confidently recovered. When false, the UI asks
   * the user to fill in the recipient before sending. */
  recipientResolved: boolean;
  /** The drafted subject (usually "Re: …"). */
  subject: string;
  /** Threading: the original Message-ID, for the reply's In-Reply-To. */
  inReplyTo: string | null;
  /** Threading: the accumulated References chain. */
  references: string[];
  /** The drafted body the answer tier produced. */
  body: string;
  /** The email source this reply answers (provenance; owner-scoped). */
  emailSourceId: string | null;
}

/**
 * The finalised draft presented to the user (GET /api/approvals/:id/email-draft).
 * The user copies it, downloads the .eml, or opens the mailto: — and sends from
 * their own client. `sent` is always false: Cogeto has no send capability.
 */
export interface EmailReplyDraftView {
  approvalId: string;
  status: ApprovalStatus;
  to: string;
  /** False when the recipient could not be recovered — the UI prompts the user
   * to set it before sending (see the forwarded-addressing rule). */
  recipientResolved: boolean;
  subject: string;
  body: string;
  /** A ready-to-open mailto: link, prefilled, that opens the user's own client. */
  mailto: string;
  /** A ready-to-download .eml (RFC822) the user can send from any client. */
  eml: string;
  /** Always false — Cogeto never sends mail; this only finalises a draft. */
  sent: false;
}

/** One attachment on a retained email, for the reading view. */
export interface EmailAttachmentDto {
  id: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number;
  /** True when the attachment is a stored file source that can be downloaded
   * (a supported document type); false when it lives only in the raw original. */
  downloadable: boolean;
  /** The file source object key (when downloadable) — used with the file
   * download endpoint. */
  fileObjectKey: string | null;
}

/**
 * The email reading view (Session O4 — email reply triggers): the full retained
 * message rendered faithfully in the source drawer so the user can see what they
 * are replying to. For a forwarded message, `originalCorrespondent` names the
 * recovered real counterpart.
 */
export interface EmailSourceDto {
  id: string;
  from: string;
  to: string;
  subject: string | null;
  sentAt: string | null;
  receivedAt: string;
  /** The text/plain body (fallback for rendering). */
  textBody: string | null;
  /** The retained SANITISED HTML body (preferred for rendering). */
  htmlBody: string | null;
  hasAttachments: boolean;
  attachments: EmailAttachmentDto[];
  scope: MemoryScope;
  sensitive: boolean;
  /** True when this message arrived as a forward. */
  isForward: boolean;
  /** The recovered original correspondent ("Ana Kovač <ana@…>"), when this is a
   * forward and the original could be recovered; else null. */
  originalCorrespondent: string | null;
  /** Whether a reply's recipient can be recovered (drives the drawer button /
   * the "recipient unset" prompt). */
  replyRecipientResolved: boolean;
}

/** A candidate email the chat resolver offers when a reply request is ambiguous. */
export interface EmailReplyCandidateDto {
  emailId: string;
  from: string;
  subject: string | null;
  receivedAt: string;
}
