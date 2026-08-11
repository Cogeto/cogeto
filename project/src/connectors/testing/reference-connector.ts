import { createHash, createHmac } from 'node:crypto';
import type {
  ConnectorDescriptor,
  ConnectorSecrets,
  FetchPageArgs,
  FetchPageResult,
  UpstreamItem,
  UpstreamItemRef,
} from '../connector-descriptor';
import { UpstreamAuthError, UpstreamRateLimitError } from '../connector-descriptor';
import type { CredentialMaterial } from '../../identity/index';

/**
 * The reference connector (V2.5 item 8.1): a fake upstream that exists only
 * in tests, implementing every behaviour a real provider will throw at the
 * platform. It is a DELIVERABLE, not a convenience: every future connector
 * is validated against these scenarios before it ships.
 *
 * The fake upstream implements: paging with opaque cursors, edits (stable id,
 * new content), deletions (delta tombstones), sub-scope discovery and moves,
 * restricted items (spec 4.4.4), expiring credentials with a refresh
 * endpoint that can be told to fail, rate limiting with Retry-After, hard
 * auth rejection, and webhook signatures over raw bytes with event ids for
 * delivery dedup.
 */

export interface FakeUpstreamItem {
  id: string;
  subScope: string;
  content: string;
  visibility: 'personal' | 'team' | 'restricted';
  deleted?: boolean;
}

export const REFERENCE_WEBHOOK_SECRET_HEADER = 'x-reference-signature';
export const REFERENCE_WEBHOOK_TIMESTAMP_HEADER = 'x-reference-timestamp';

export class FakeUpstream {
  /** Ordered per sub-scope: the upstream's listing order. */
  private items: FakeUpstreamItem[] = [];
  private subScopeLabels = new Map<string, string>();
  /** Counters the tests assert against: every upstream touch is counted. */
  fetchPageCalls = 0;
  fetchItemCalls = 0;
  refreshCalls = 0;
  /** Rate-limit injection: the next N fetches throw 429 with this wait. */
  rateLimitNext = 0;
  retryAfterSeconds = 60;
  /** Auth: the token the upstream currently accepts. */
  validToken = 'token-1';
  /** When true, refresh fails (revoked from the provider's side). */
  refuseRefresh = false;
  pageSize = 2;

  addSubScope(key: string, label: string): void {
    this.subScopeLabels.set(key, label);
  }

  put(item: FakeUpstreamItem): void {
    const existing = this.items.findIndex((i) => i.id === item.id);
    if (existing >= 0) this.items[existing] = item;
    else this.items.push(item);
    if (!this.subScopeLabels.has(item.subScope)) {
      this.subScopeLabels.set(item.subScope, item.subScope);
    }
  }

  edit(id: string, content: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(`no such upstream item: ${id}`);
    item.content = content;
  }

  move(id: string, subScope: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(`no such upstream item: ${id}`);
    item.subScope = subScope;
  }

  delete(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new Error(`no such upstream item: ${id}`);
    item.deleted = true;
  }

  private guard(secrets: ConnectorSecrets): void {
    if (secrets?.accessToken !== this.validToken) {
      throw new UpstreamAuthError('reference upstream: bad token');
    }
  }

  /** Rate limiting applies to the item endpoints, where real providers
   * throttle; discovery stays cheap. */
  private maybeRateLimit(): void {
    if (this.rateLimitNext > 0) {
      this.rateLimitNext -= 1;
      throw new UpstreamRateLimitError(this.retryAfterSeconds);
    }
  }

  listSubScopes(secrets: ConnectorSecrets): { key: string; label: string }[] {
    this.guard(secrets);
    return [...this.subScopeLabels.entries()].map(([key, label]) => ({ key, label }));
  }

  fetchPage(secrets: ConnectorSecrets, args: FetchPageArgs): FetchPageResult {
    this.fetchPageCalls += 1;
    this.maybeRateLimit();
    this.guard(secrets);
    const inScope = this.items.filter(
      (item) => args.subScope === null || item.subScope === args.subScope,
    );
    // A cursor at or past the end models the upstream whose delta endpoint
    // re-lists from the top on the next sync: exactly the polling shape that
    // makes the natural-key ledger the only thing between a re-list and N
    // re-extractions.
    const offset =
      typeof args.cursor === 'number' && args.cursor < inScope.length ? args.cursor : 0;
    const limit = Math.min(args.limit, this.pageSize);
    const page = inScope.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      items: page.map((item) => toUpstreamItem(item)),
      cursor: next,
      done: next >= inScope.length,
    };
  }

  fetchItem(secrets: ConnectorSecrets, ref: UpstreamItemRef): UpstreamItem | null {
    this.fetchItemCalls += 1;
    this.maybeRateLimit();
    this.guard(secrets);
    const item = this.items.find((i) => `ref-${i.id}` === ref.naturalKey);
    if (!item || item.deleted) return null;
    return toUpstreamItem(item);
  }

  refresh(secrets: ConnectorSecrets): { material: CredentialMaterial; expiresAt: Date } {
    this.refreshCalls += 1;
    if (this.refuseRefresh || secrets?.refreshToken !== 'refresh-1') {
      throw new UpstreamAuthError('reference upstream: refresh rejected');
    }
    const rotated = `token-${Number(this.validToken.split('-')[1]) + 1}`;
    this.validToken = rotated;
    return {
      material: { accessToken: rotated, refreshToken: 'refresh-1' },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
  }

  /** A signed webhook delivery, as the provider would send it. */
  signDelivery(
    secret: string,
    eventId: string,
    itemIds: string[],
    at = new Date(),
  ): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(
      JSON.stringify({
        event_id: eventId,
        items: itemIds.map((id) => ({ natural_key: `ref-${id}` })),
      }),
      'utf8',
    );
    const stamp = String(Math.floor(at.getTime() / 1000));
    const signature = createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${stamp}.`), body]))
      .digest('hex');
    return {
      body,
      headers: {
        [REFERENCE_WEBHOOK_SECRET_HEADER]: `sha256=${signature}`,
        [REFERENCE_WEBHOOK_TIMESTAMP_HEADER]: stamp,
      },
    };
  }
}

function toUpstreamItem(item: FakeUpstreamItem): UpstreamItem {
  const bytes = Buffer.from(item.content, 'utf8');
  return {
    naturalKey: `ref-${item.id}`,
    subScope: item.subScope,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    content: {
      bytes,
      filename: `${item.id}.txt`,
      contentType: 'text/plain',
    },
    visibility: item.visibility,
    deleted: item.deleted,
  };
}

/** The descriptor a real connector module would register. */
export function referenceConnector(upstream: FakeUpstream): ConnectorDescriptor {
  return {
    kind: 'reference',
    // The fake materializes byte-backed items through the one upload path,
    // so its sources are ordinary files.
    sourceType: 'file',
    auth: 'oauth2',
    authorship: 'observed',
    hasSubScopes: true,
    listSubScopes: async (secrets) => upstream.listSubScopes(secrets),
    fetchPage: async (secrets, args) => upstream.fetchPage(secrets, args),
    fetchItem: async (secrets, ref) => upstream.fetchItem(secrets, ref),
    refresh: async (secrets) => upstream.refresh(secrets),
    webhook: {
      signatureHeader: REFERENCE_WEBHOOK_SECRET_HEADER,
      algorithm: 'sha256',
      encoding: 'hex',
      signaturePrefix: 'sha256=',
      timestampHeader: REFERENCE_WEBHOOK_TIMESTAMP_HEADER,
      toleranceSeconds: 300,
      parseEvent: (payload) => {
        const p = payload as { event_id?: unknown; items?: unknown };
        if (typeof p?.event_id !== 'string') return null;
        const items = Array.isArray(p.items)
          ? p.items
              .map((i) => (i as { natural_key?: unknown }).natural_key)
              .filter((k): k is string => typeof k === 'string')
              .map((naturalKey) => ({ naturalKey }))
          : [];
        return { eventId: p.event_id, items };
      },
    },
    rate: { capacity: 100, refillPerSecond: 50 },
  };
}
