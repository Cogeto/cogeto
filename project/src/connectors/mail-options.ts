/** Inbound-email knobs from validated config (decision 0028). */
export interface MailOptions {
  /** The instance's unique inbound address (ruling 1), or null when unconfigured. */
  inboundAddress: string | null;
  /** Hard message-size cap in bytes (ruling 6). */
  maxBytes: number;
  /** Total-attachments-size cap in bytes (ruling 6). */
  attachmentsMaxBytes: number;
  /** Optional capture-owner email (ruling 3); when unset, the sole user is used. */
  captureUserEmail: string | null;
  /**
   * Shared secret the Haraka queue hook presents to the internal intake
   * endpoint (ruling 7). Empty disables the endpoint (fail-closed) — set at
   * provision time alongside the mail service.
   */
  intakeToken: string;
}

export const MAIL_OPTIONS = Symbol('MAIL_OPTIONS');
