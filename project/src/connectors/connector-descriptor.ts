import type { SourceTypeKey } from '@cogeto/shared';
import type { CredentialMaterial } from '../identity/index';

/**
 * The connector contract (V2.5 item 8.1, issue A; decision record
 * docs/features/connectors.md, frozen before this file was written).
 *
 * A connector is an adapter for one external system, declared as a
 * descriptor and registered through the composition roots. It declares what
 * the platform cannot know (how to list, fetch, and identify the upstream's
 * items; how its webhooks are signed; whose words its content carries) and
 * inherits everything operational: lifecycle, credentials, cursors,
 * deduplication, backfill bounds, webhook ingress, rate limiting, admission
 * and capabilities reporting.
 *
 * What a connector may never do is enforced by the module rules and the
 * confinement specs rather than restated here: no own HTTP ingress, no own
 * secret storage, no model calls, no unbounded backfill, no memory deletion.
 */

/** A reference to one upstream item: the dedup identity plus its container. */
export interface UpstreamItemRef {
  /**
   * The upstream identifier, container-independent by contract: the same
   * item seen in two sub-scopes MUST yield the same key, which is what makes
   * it one source rather than two.
   */
  naturalKey: string;
  subScope?: string | null;
}

/** One item as fetched, ready for the platform's dedup decision. */
export interface UpstreamItem extends UpstreamItemRef {
  /**
   * sha256 hex over the content bytes. The platform computes it when absent;
   * a connector whose upstream provides a stable content hash or version tag
   * should map it here so an unchanged item is skipped without reading its
   * bytes at all.
   */
  contentHash?: string;
  /** The content to materialize. Byte-backed items go through the ONE
   * existing upload path as ordinary file sources. */
  content: {
    bytes: Buffer;
    filename: string;
    contentType: string;
  };
  /**
   * The upstream's visibility, mapped structurally (spec 4.4.4): `team`
   * becomes a shared source, `personal` becomes private, and `restricted`
   * (visible to a subset of users) is SKIPPED and reported in the sync
   * summary. Never a model judgment.
   */
  visibility: 'personal' | 'team' | 'restricted';
  /** True when the upstream reports the item deleted (a delta tombstone).
   * The ledger records it; the source remains. */
  deleted?: boolean;
}

export interface FetchPageArgs {
  subScope: string | null;
  /** Opaque to the platform: whatever token, timestamp or sequence the
   * upstream provides, persisted per connector and per sub-scope. */
  cursor: unknown;
  /** Page size bound the platform asks for; the upstream may return fewer. */
  limit: number;
  /**
   * Present during a bounded backfill: fetch no items older than this.
   * Incremental sync passes null and relies on the cursor.
   */
  since: Date | null;
}

export interface FetchPageResult {
  items: UpstreamItem[];
  /** The cursor to persist after this page; null when the upstream has no
   * further delta state. */
  cursor: unknown;
  /** True when this listing is exhausted (backfill window done, or the
   * incremental delta is fully consumed). */
  done: boolean;
}

/** What fetch and discovery receive: the opened credential material, or null
 * for `auth: 'none'` connectors. Handed only to worker-side code. */
export type ConnectorSecrets = CredentialMaterial | null;

/**
 * The provider's webhook contract. Verification runs over the RAW bytes
 * before anything is parsed; payloads are signals, never content, so the
 * parse extracts identifiers only and the processor re-fetches the item
 * through the normal outbound path.
 */
export interface ConnectorWebhookScheme {
  /** Header carrying the signature, lowercase. */
  signatureHeader: string;
  algorithm: 'sha256' | 'sha1';
  encoding: 'hex' | 'base64';
  /** Literal prefix some providers prepend, e.g. `sha256=`. */
  signaturePrefix?: string;
  /** Header carrying the delivery timestamp (seconds or ISO), lowercase.
   * When declared, it is included in the signed string as `timestamp.body`
   * and deliveries outside the tolerance are refused (replay protection). */
  timestampHeader?: string;
  /** Seconds of clock skew tolerated; default 300. */
  toleranceSeconds?: number;
  /**
   * Extract the delivery identity and the item references from the VERIFIED,
   * parsed payload. Returning null refuses the delivery as unparseable.
   * Identifiers only: nothing returned here is ever stored as content.
   */
  parseEvent(
    payload: unknown,
    headers: Record<string, string | undefined>,
  ): { eventId: string; items: UpstreamItemRef[] } | null;
  /**
   * Renew the provider-side subscription; returns the new expiry, or null
   * for one that no longer expires. Absent = subscriptions do not expire.
   */
  renew?(secrets: ConnectorSecrets): Promise<Date | null>;
}

export interface ConnectorRateProfile {
  /** Token bucket capacity (burst size). */
  capacity: number;
  /** Tokens restored per second. */
  refillPerSecond: number;
}

export interface ConnectorDescriptor {
  /** The registry key. Stable, never renamed. */
  kind: string;
  /**
   * The registered source type its materialized sources carry. Must be a key
   * in the shared source-type registry; the connector's own module registers
   * the type with its reader and deletion ports (spec 15.3), so adding a
   * connector requires no migration and no edit inside `memory`.
   */
  sourceType: SourceTypeKey;
  auth: 'oauth2' | 'api_key' | 'none';
  /**
   * Whose words the content carries: `authored` is the user's own,
   * `observed` is third-party content. Decides the admission default (an
   * observed connector is bounded far tighter) and must be consistent with
   * the source type's `userAuthored` declaration.
   */
  authorship: 'authored' | 'observed';
  /** Whether the upstream has containers to select. When false, the platform
   * syncs one implicit whole-connector scope. */
  hasSubScopes: boolean;
  /** Discover the upstream's containers. Required when `hasSubScopes`. */
  listSubScopes?(secrets: ConnectorSecrets): Promise<{ key: string; label: string }[]>;
  fetchPage(secrets: ConnectorSecrets, args: FetchPageArgs): Promise<FetchPageResult>;
  /** One targeted item, for webhook-triggered sync. Null = gone upstream. */
  fetchItem(secrets: ConnectorSecrets, ref: UpstreamItemRef): Promise<UpstreamItem | null>;
  /**
   * Rotate the credential before expiry. Required for `auth: 'oauth2'`.
   * Throwing (or a rejected upstream call) moves the connector to
   * needs_reauth; the platform never retries a refresh forever.
   */
  refresh?(
    secrets: ConnectorSecrets,
  ): Promise<{ material: CredentialMaterial; expiresAt: Date | null }>;
  webhook?: ConnectorWebhookScheme;
  /** Outbound politeness profile; a conservative default applies if absent. */
  rate?: ConnectorRateProfile;
}

/**
 * Typed upstream failures the sync engine classifies. Connectors throw
 * these from fetch/discovery/refresh so the platform can respond correctly:
 * a rate limit reschedules beyond the named wall, an auth failure moves to
 * needs_reauth, anything else degrades with a reason.
 */
export class UpstreamRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`upstream rate limited; retry after ${retryAfterSeconds}s`);
    this.name = 'UpstreamRateLimitError';
  }
}

export class UpstreamAuthError extends Error {
  constructor(message = 'upstream rejected the credential') {
    super(message);
    this.name = 'UpstreamAuthError';
  }
}
