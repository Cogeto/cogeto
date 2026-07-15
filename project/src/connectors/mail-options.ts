/** Inbound-email knobs from validated config (decision 0028). */
export interface MailOptions {
  /** The instance's unique inbound address (ruling 1), or null when unconfigured. */
  inboundAddress: string | null;
  /** Hard message-size cap in bytes (ruling 6). */
  maxBytes: number;
  /** Total-attachments-size cap in bytes (ruling 6). */
  attachmentsMaxBytes: number;
  /**
   * The bootstrap admin's email (decision 0031): the operator account is
   * excluded from sender-routed capture. Null → no exclusion.
   */
  adminUserEmail: string | null;
  /**
   * Shared secret the Haraka queue hook presents to the internal intake
   * endpoint (ruling 7). Empty disables the endpoint (fail-closed) — set at
   * provision time alongside the mail service.
   */
  intakeToken: string;
}

export const MAIL_OPTIONS = Symbol('MAIL_OPTIONS');
