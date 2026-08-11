export const CONNECTORS_OPTIONS = Symbol('CONNECTORS_OPTIONS');

/** Provided by the composition roots; the module reads no environment. */
export interface ConnectorsOptions {
  /**
   * The instance master key, for sealing the webhook signing secret at rest.
   * The same key seals provider API keys and connector credentials: ONE
   * mechanism (infrastructure/secret-box).
   */
  masterKey: Buffer | null;
  /** Raw-body cap for the hostile-facing webhook ingress; default 1 MiB. */
  webhookMaxBytes?: number;
  /** Webhook deliveries accepted per connector per window (durable). */
  webhookMaxPerWindow?: number;
  webhookRateWindowSeconds?: number;
}

export const WEBHOOK_MAX_BYTES_DEFAULT = 1024 * 1024;
export const WEBHOOK_MAX_PER_WINDOW_DEFAULT = 300;
export const WEBHOOK_RATE_WINDOW_SECONDS_DEFAULT = 60;

/**
 * Admission defaults per authorship class (issue E2), stated as constants so
 * changing one is a reviewed decision. An observed connector (third-party
 * content at volume) is bounded far tighter than an authored one, because a
 * busy channel or shared drive can produce more content in a day than a
 * professional writes in a year. Configurable per connector
 * (`settings.dailyItemCap`) and per sub-scope (`item_cap`).
 */
export const OBSERVED_DAILY_ITEM_CAP = 200;
export const AUTHORED_DAILY_ITEM_CAP = 1000;

/** Bounded-backfill defaults (issue C4): never silently unbounded. */
export const BACKFILL_DEFAULT_DAYS = 30;
export const BACKFILL_DEFAULT_ITEM_CAP = 500;
