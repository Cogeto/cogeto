import type { SourceTypeKey } from '@cogeto/shared';
import type { DbOrTx } from '../infrastructure/index';
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

/** The bytes to materialize through the ONE existing upload path. */
export interface UpstreamItemContent {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Lazy content: called ONLY when the ledger decided to materialize, so an
 * unchanged item never fetches its body (the zero-cost re-sync property,
 * issue C2 of the first real connector). May resolve to `'restricted'` when
 * the item turns out to be visible to a subset of users (skipped and
 * reported, spec 4.4.4) or `null` when it is gone upstream by the time it
 * is fetched. A thrown `UpstreamRateLimitError` pauses the pass beyond the
 * wall instead of failing the item.
 */
export type LazyUpstreamContent = () => Promise<UpstreamItemContent | 'restricted' | null>;

/** One item as fetched, ready for the platform's dedup decision. */
export interface UpstreamItem extends UpstreamItemRef {
  /**
   * sha256 hex over the content bytes, or any stable upstream change marker
   * (a version tag hashed). The platform computes it from the bytes when
   * absent; REQUIRED when `content` is lazy, because the skip decision must
   * run before any bytes exist.
   */
  contentHash?: string;
  /** The content to materialize, eager or lazy. Byte-backed items go
   * through the ONE existing upload path as ordinary file sources. */
  content: UpstreamItemContent | LazyUpstreamContent;
  /**
   * The upstream's own revision marker for this item's current content (a
   * Confluence version number), recorded on the `source_revision` basis
   * when an edit supersedes, so a finding resolved by the edit can name it.
   */
  upstreamRevision?: string | null;
  /** Connector-private payload carried to `annotate`; opaque to the
   * platform, never stored by it. */
  meta?: unknown;
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
  /**
   * The sub-scope's per-scope settings row, verbatim (V2.5 item 8.2): the
   * platform stores it, the descriptor interprets it (the attachments
   * toggle). Null when the scope has none.
   */
  scopeSettings: unknown;
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
  /**
   * Accept or refuse a CUSTOM sub-scope key the user adds by hand, for
   * containers discovery cannot enumerate (a page subtree). Absent = no
   * custom sub-scopes. Pure grammar check; upstream validation happens on
   * the next sync, which fails the scope with a named reason.
   */
  acceptSubScopeKey?(key: string): boolean;
  /**
   * Page through the natural keys the upstream CURRENTLY lists for one
   * sub-scope, identifiers only, for the presence sweep: polling by
   * modified date structurally cannot observe an absence. `state` defaults
   * to `present`; `archived` distinguishes an archive from a deletion where
   * the upstream can say. Absent = no sweep for this connector.
   */
  listKeys?(
    secrets: ConnectorSecrets,
    args: { subScope: string | null; cursor: unknown; limit: number },
  ): Promise<{
    keys: { naturalKey: string; state?: 'present' | 'archived' }[];
    cursor: unknown;
    done: boolean;
  }>;
  /** Days between presence sweeps; default 7 where `listKeys` exists. */
  presenceSweepDays?: number;
  /**
   * Record connector-owned provenance for a just-materialized source (its
   * own table, the module rules unchanged). Failures are logged and never
   * fail the sync: provenance is metadata, the source already exists.
   */
  annotate?(
    db: DbOrTx,
    item: UpstreamItem,
    source: { sourceType: string; sourceId: string },
    connector: { id: string; ownerId: string; orgId: string },
  ): Promise<void>;
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
