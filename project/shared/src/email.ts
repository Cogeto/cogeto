import type { ApprovalStatus } from './approvals';

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
 * inbound address, the current allowlist, and recent refusals for one-click
 * allowlisting.
 */
export interface EmailCaptureConfigDto {
  /** The instance's unique inbound address (decision 0028 ruling 1), or null
   * when the instance has not been configured with one yet. */
  inboundAddress: string | null;
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
  /** The recipient — the original sender's address. */
  to: string;
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
  subject: string;
  body: string;
  /** A ready-to-open mailto: link, prefilled, that opens the user's own client. */
  mailto: string;
  /** A ready-to-download .eml (RFC822) the user can send from any client. */
  eml: string;
  /** Always false — Cogeto never sends mail; this only finalises a draft. */
  sent: false;
}
