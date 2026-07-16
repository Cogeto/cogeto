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
  /**
   * Require an AUTHENTICATED sender for the "registered user routes to self"
   * rule (SEC-1). When true (the default, production), a message is only
   * captured for the registered user whose address it claims to be from if the
   * SMTP sender passed SPF — so a spoofed `MAIL FROM:<victim@registered-domain>`
   * from an unauthorised host cannot inject memory into that user's account. A
   * message that hard-fails SPF (`fail`/`softfail`) is refused outright. Set
   * false only for a closed test instance without inbound SPF.
   */
  requireAuthenticatedSender: boolean;
  /**
   * Max accepted messages per sender address within the intake rate window
   * (SEC-2). Bounds the ingestion/model spend an internet sender can drive on
   * the public inbound port. 0 disables the cap.
   */
  intakeMaxPerSenderPerWindow: number;
  /** The intake rate window, in seconds (SEC-2). */
  intakeRateWindowSeconds: number;
}

export const MAIL_OPTIONS = Symbol('MAIL_OPTIONS');
