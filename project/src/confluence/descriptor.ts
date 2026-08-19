import { createHash } from 'node:crypto';
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  DEFAULT_UPLOAD_MAX_BYTES,
  MARKDOWN_CONTENT_TYPE,
} from '@cogeto/shared';
import { UpstreamAuthError, UpstreamRateLimitError } from '../connectors/index';
import type { ConnectorDescriptor, ConnectorSecrets, UpstreamItem } from '../connectors/index';
import { ConfluenceClient, ConfluenceHttpError } from './client';
import type { ConfluenceAuth, SearchResultItem } from './client';
import { convertStorageFormat } from './storage-format';
import { recordConfluenceProvenance } from './persistence/page-store';
import type { ConfluenceProvenance } from './persistence/page-store';

/**
 * The Confluence Cloud connector descriptor (V2.5 item 8.2; decision record
 * docs/features/confluence.md). Everything operational is the platform's;
 * this file declares what the platform cannot know:
 *
 * - Sub-scopes are SPACES (`space:{KEY}`), plus custom page subtrees
 *   (`page:{pageId}`) for narrowing where a whole space is too broad.
 * - Discovery and incremental listing ride ONE CQL content search, newest
 *   modified first, bounded by the backfill window or the stored watermark.
 * - Change detection is the page version number: the content hash is a hash
 *   of `id:version` from the body-less listing, and content is LAZY, so an
 *   unchanged page costs a listing line and nothing else (the zero-cost
 *   re-sync property, proven by test).
 * - Read-only rests on the client: every operation here is a read.
 */

export const CONFLUENCE_KIND = 'confluence';

/** Sub-scope key grammar. */
const SPACE_SCOPE = /^space:([A-Za-z0-9~._-]+)$/;
const PAGE_SCOPE = /^page:(\d+)$/;

/** Presence sweep cadence: weekly, plus on demand. */
const PRESENCE_DAYS = 7;

/**
 * The incremental watermark is re-listed with one day of slack: CQL's
 * lastmodified compares in the site's timezone, and losing an edit to a
 * timezone boundary would be silent. The ledger absorbs the overlap free.
 */
const WATERMARK_SLACK_MS = 24 * 60 * 60 * 1000;

/** Attachments larger than the upload ceiling are never downloaded. */
const ATTACHMENT_MAX_BYTES = DEFAULT_UPLOAD_MAX_BYTES;

interface ConfluenceCursor {
  /** ISO instant of the newest modification fully processed. */
  watermark?: string | null;
  /** The newest modification seen by the CURRENT listing; promoted to the
   * watermark when the listing completes. */
  pendingWatermark?: string | null;
  /** The site-relative next-page path of the current listing. */
  next?: string | null;
}

interface PresenceCursor {
  phase: 'current' | 'archived' | 'attachments';
  next: string | null;
  spaceId: string | null;
}

/** Connector-private payload carried on UpstreamItem.meta to annotate. */
export interface ConfluenceItemMeta extends ConfluenceProvenance {
  kind: 'page' | 'attachment';
}

interface ScopeSettings {
  attachments?: boolean;
}

export function confluenceConnector(
  options: { fetchImpl?: typeof fetch } = {},
): ConnectorDescriptor {
  const clientFor = (secrets: ConnectorSecrets): ConfluenceClient =>
    new ConfluenceClient(authFrom(secrets), options.fetchImpl ?? fetch);

  return {
    kind: CONFLUENCE_KIND,
    // Pages are byte-backed documents through the ONE upload path, so their
    // sources are ordinary files (userAuthored: never, the first-person
    // rule holds structurally for colleague-authored content).
    sourceType: 'file',
    auth: 'api_key',
    authorship: 'observed',
    hasSubScopes: true,
    presenceSweepDays: PRESENCE_DAYS,
    rate: { capacity: 10, refillPerSecond: 2 },

    acceptSubScopeKey: (key) => PAGE_SCOPE.test(key),

    listSubScopes: async (secrets) =>
      mapUpstreamErrors(async () => {
        const client = clientFor(secrets);
        const scopes: { key: string; label: string }[] = [];
        let cursor: string | null = null;
        // Bounded: 5 pages of 100 spaces is far beyond any site that should
        // be connected wholesale.
        for (let page = 0; page < 5; page += 1) {
          const { spaces, next } = await client.listSpaces(cursor);
          for (const space of spaces) {
            scopes.push({
              key: `space:${space.key}`,
              label: `${space.name} (${space.key})`,
            });
          }
          if (!next) break;
          cursor = next;
        }
        return scopes;
      }),

    fetchPage: async (secrets, args) =>
      mapUpstreamErrors(async () => {
        const client = clientFor(secrets);
        const auth = authFrom(secrets);
        const cursor = (args.cursor ?? {}) as ConfluenceCursor;
        const settings = (args.scopeSettings ?? {}) as ScopeSettings;
        const cql = cqlFor(args.subScope, settings, args.since, cursor.watermark ?? null);
        const { items, next } = await client.searchContent(cql, {
          cursorPath: cursor.next ?? null,
          limit: args.limit,
        });

        const upstreamItems: UpstreamItem[] = [];
        for (const found of items) {
          const item = toUpstreamItem(client, auth, found, settings);
          if (item) upstreamItems.push(item);
        }

        // The newest modification this listing saw becomes the watermark
        // only when the listing COMPLETES: a crashed listing re-lists.
        const pending =
          cursor.next === null || cursor.next === undefined
            ? (items[0]?.modifiedAt ?? cursor.watermark ?? null)
            : (cursor.pendingWatermark ?? null);
        const done = next === null;
        const nextCursor: ConfluenceCursor = done
          ? { watermark: pending ?? cursor.watermark ?? null, pendingWatermark: null, next: null }
          : { watermark: cursor.watermark ?? null, pendingWatermark: pending, next };
        return { items: upstreamItems, cursor: nextCursor, done };
      }),

    fetchItem: async (secrets, ref) =>
      mapUpstreamErrors(async () => {
        // No webhook exists for an API-token connector, so this is only a
        // completeness path (the platform contract requires it). Pages are
        // fetched properly; attachment lifecycle is owned by the poll and
        // the presence sweep.
        const pageMatch = /^conf:page:(\d+)$/.exec(ref.naturalKey);
        if (!pageMatch) return null;
        const client = clientFor(secrets);
        const auth = authFrom(secrets);
        const body = await client.getPageBody(pageMatch[1]!);
        if (!body) return null;
        if (await client.hasReadRestrictions(body.id)) return null;
        const text = convertStorageFormat(body.storage);
        const meta: ConfluenceItemMeta = {
          kind: 'page',
          pageId: body.id,
          title: body.title,
          spaceKey: null,
          spaceName: null,
          version: body.version,
          url: body.webuiPath ? `${auth.siteUrl}/wiki${body.webuiPath}` : null,
          parentPageId: body.parentId,
          parentTitle: null,
        };
        return {
          naturalKey: `conf:page:${body.id}`,
          subScope: null,
          contentHash: versionHash('page', body.id, body.version),
          upstreamRevision: String(body.version),
          visibility: 'team',
          meta,
          content: {
            bytes: Buffer.from(text, 'utf8'),
            filename: breadcrumbFilename([body.title]),
            contentType: MARKDOWN_CONTENT_TYPE,
          },
        };
      }),

    listKeys: async (secrets, args) =>
      mapUpstreamErrors(async () => {
        const client = clientFor(secrets);
        const scope = args.subScope ?? '';
        const pageMatch = PAGE_SCOPE.exec(scope);
        if (pageMatch) {
          // A page subtree: current descendants via the same CQL identity.
          const cursor = (args.cursor ?? { phase: 'current', next: null }) as PresenceCursor;
          const { items, next } = await client.searchContent(
            `(id = ${pageMatch[1]!} or ancestor = ${pageMatch[1]!}) and type = page order by lastmodified desc`,
            { cursorPath: cursor.next, limit: args.limit },
          );
          return {
            keys: items.map((item) => ({ naturalKey: `conf:page:${item.id}` })),
            cursor: { phase: 'current', next, spaceId: null } satisfies PresenceCursor,
            done: next === null,
          };
        }
        const spaceMatch = SPACE_SCOPE.exec(scope);
        if (!spaceMatch) return { keys: [], cursor: null, done: true };
        const spaceKey = spaceMatch[1]!;
        let cursor = (args.cursor ?? null) as PresenceCursor | null;
        if (!cursor) {
          const spaceId = await client.spaceIdForKey(spaceKey);
          if (!spaceId) return { keys: [], cursor: null, done: true };
          cursor = { phase: 'current', next: null, spaceId };
        }
        if (cursor.phase === 'attachments') {
          const { items, next } = await client.searchContent(
            `space = "${spaceKey}" and type = attachment order by lastmodified desc`,
            { cursorPath: cursor.next, limit: args.limit },
          );
          return {
            keys: items.map((item) => ({ naturalKey: `conf:att:${item.id}` })),
            cursor: { ...cursor, next },
            done: next === null,
          };
        }
        const status = cursor.phase;
        const { ids, next } = await client.listPageIds(cursor.spaceId!, status, cursor.next);
        const keys = ids.map((id) => ({
          naturalKey: `conf:page:${id}`,
          ...(status === 'archived' ? { state: 'archived' as const } : {}),
        }));
        if (next) return { keys, cursor: { ...cursor, next }, done: false };
        // Phase complete: current -> archived -> attachments -> done.
        const nextPhase = status === 'current' ? 'archived' : 'attachments';
        return {
          keys,
          cursor: { phase: nextPhase, next: null, spaceId: cursor.spaceId },
          done: false,
        };
      }),

    annotate: async (db, item, source, connector) => {
      const meta = item.meta as ConfluenceItemMeta | undefined;
      if (!meta) return;
      await recordConfluenceProvenance(db, {
        ownerId: connector.ownerId,
        orgId: connector.orgId,
        // The COGETO space is the connector's (docs/features/spaces.md);
        // meta carries only Confluence's own space key and name.
        spaceId: connector.spaceId,
        connectorId: connector.id,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        ...meta,
      });
    },
  };
}

function authFrom(secrets: ConnectorSecrets): ConfluenceAuth {
  const siteUrl = secrets?.extras?.siteUrl;
  const email = secrets?.extras?.email;
  const apiToken = secrets?.accessToken;
  if (!siteUrl || !email || !apiToken) {
    throw new UpstreamAuthError('the Confluence credential is incomplete');
  }
  return { siteUrl, email, apiToken };
}

function versionHash(kind: 'page' | 'att', id: string, version: number | null): string {
  // The upstream's own change marker stands in for a content hash, which is
  // exactly what lets an unchanged item skip without any bytes existing.
  return createHash('sha256')
    .update(`${kind}:${id}:v${version ?? 0}`)
    .digest('hex');
}

function cqlFor(
  subScope: string | null,
  settings: ScopeSettings,
  since: Date | null,
  watermark: string | null,
): string {
  const scope = subScope ?? '';
  const pageMatch = PAGE_SCOPE.exec(scope);
  const spaceMatch = SPACE_SCOPE.exec(scope);
  let identity: string;
  let types: string;
  if (pageMatch) {
    identity = `(id = ${pageMatch[1]!} or ancestor = ${pageMatch[1]!})`;
    // A page subtree syncs pages only: CQL cannot express "attachments of
    // descendants" (decision record, issue D3).
    types = 'type = page';
  } else if (spaceMatch) {
    identity = `space = "${spaceMatch[1]!}"`;
    types = settings.attachments ? 'type in (page, attachment)' : 'type = page';
  } else {
    identity = 'id = 0'; // an unparseable scope lists nothing, loudly empty
    types = 'type = page';
  }
  const bound = since ?? (watermark ? new Date(Date.parse(watermark) - WATERMARK_SLACK_MS) : null);
  const dateClause = bound ? ` and lastmodified >= "${cqlDate(bound)}"` : '';
  return `${identity} and ${types}${dateClause} order by lastmodified desc`;
}

function cqlDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
}

function toUpstreamItem(
  client: ConfluenceClient,
  auth: ConfluenceAuth,
  found: SearchResultItem,
  settings: ScopeSettings,
): UpstreamItem | null {
  const visibility = found.spaceType === 'personal' ? 'personal' : 'team';
  const url = found.webuiPath ? `${auth.siteUrl}/wiki${found.webuiPath}` : null;

  if (found.type === 'page') {
    const meta: ConfluenceItemMeta = {
      kind: 'page',
      pageId: found.id,
      title: found.title,
      spaceKey: found.spaceKey,
      spaceName: found.spaceName,
      version: found.version,
      url,
      parentPageId: found.parentId,
      parentTitle: found.parentTitle,
    };
    return {
      naturalKey: `conf:page:${found.id}`,
      subScope: null,
      contentHash: versionHash('page', found.id, found.version),
      upstreamRevision: found.version === null ? null : String(found.version),
      visibility,
      meta,
      // LAZY: resolved only when the ledger decided to materialize, so an
      // unchanged page never fetches its body (issue C2).
      content: async () => {
        if (await client.hasReadRestrictions(found.id)) return 'restricted';
        const body = await client.getPageBody(found.id);
        if (!body) return null;
        const text = convertStorageFormat(body.storage);
        meta.title = body.title;
        meta.version = body.version;
        if (body.webuiPath) meta.url = `${auth.siteUrl}/wiki${body.webuiPath}`;
        return {
          bytes: Buffer.from(text, 'utf8'),
          filename: breadcrumbFilename([found.spaceName, found.parentTitle, body.title]),
          contentType: MARKDOWN_CONTENT_TYPE,
        };
      },
    };
  }

  // Attachments: only when the scope opted in, only types the reading layer
  // accepts, never past the upload ceiling (nothing is downloaded to find
  // out; the listing already says).
  if (!settings.attachments) return null;
  if (!found.mediaType || !ALLOWED_UPLOAD_CONTENT_TYPES.includes(found.mediaType)) return null;
  if (found.fileSize !== null && found.fileSize > ATTACHMENT_MAX_BYTES) return null;
  if (!found.downloadPath) return null;
  const meta: ConfluenceItemMeta = {
    kind: 'attachment',
    pageId: found.containerId ?? '',
    attachmentId: found.id,
    title: found.title,
    spaceKey: found.spaceKey,
    spaceName: found.spaceName,
    version: found.version,
    url,
    parentPageId: found.containerId,
    parentTitle: found.containerTitle,
  };
  const downloadPath = found.downloadPath;
  return {
    naturalKey: `conf:att:${found.id}`,
    subScope: null,
    contentHash: versionHash('att', found.id, found.version),
    upstreamRevision: found.version === null ? null : String(found.version),
    visibility,
    meta,
    content: async () => {
      if (meta.pageId && (await client.hasReadRestrictions(meta.pageId))) return 'restricted';
      const downloaded = await client.downloadAttachment(downloadPath);
      if (!downloaded) return null;
      return {
        bytes: downloaded.bytes,
        filename: found.title || `attachment-${found.id}`,
        contentType: found.mediaType ?? downloaded.contentType,
      };
    },
  };
}

/** `Space / Parent / Title.md`, the anchor stage's whole hierarchy signal
 * (issue D4): capped, newline-free, always ending in .md. */
export function breadcrumbFilename(parts: (string | null | undefined)[]): string {
  const joined = parts
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .join(' / ');
  const capped = joined.length > 180 ? joined.slice(joined.length - 180) : joined;
  return `${capped || 'untitled'}.md`;
}

/** Client failures, classified the way the platform responds to them. */
async function mapUpstreamErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConfluenceHttpError) {
      if (error.status === 401 || error.status === 403) {
        throw new UpstreamAuthError(`Confluence rejected the credential (${error.status})`);
      }
      if (error.status === 429) {
        throw new UpstreamRateLimitError(error.retryAfterSeconds ?? 60);
      }
    }
    throw error;
  }
}
