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
