/**
 * The Confluence Cloud client (V2.5 item 8.2, issue A): READ-ONLY BY
 * CONSTRUCTION. Exactly one request helper exists and it hard-codes GET; no
 * create, update or delete method exists anywhere in this module, and
 * read-only.spec.ts fails the build if a mutating verb appears. An Atlassian
 * API token carries the account's full permissions, so this file is what
 * read-only rests on; the stronger arrangement (a dedicated read-only
 * account) is documented in docs/security/confluence-connector.md.
 *
 * Dependency-free: fetch is the platform's own, injectable for tests.
 */

/** One HTTP failure, with what the connect flow needs to say WHY. */
export class ConfluenceHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterSeconds: number | null,
    message?: string,
  ) {
    super(message ?? `Confluence answered ${status}`);
    this.name = 'ConfluenceHttpError';
  }
}

/** DNS, TLS or socket failure: the site did not answer at all. */
export class ConfluenceUnreachableError extends Error {
  constructor(cause: string) {
    super(`Confluence site unreachable: ${cause}`);
    this.name = 'ConfluenceUnreachableError';
  }
}

/** The site answered, but not as a Confluence Cloud API. */
export class ConfluenceNotAConfluenceError extends Error {
  constructor() {
    super('the site answered, but not as a Confluence Cloud API');
    this.name = 'ConfluenceNotAConfluenceError';
  }
}

export interface ConfluenceAuth {
  /** Normalized site base, e.g. https://acme.atlassian.net (no /wiki). */
  siteUrl: string;
  email: string;
  apiToken: string;
}

/**
 * Accepts what a user really types (acme.atlassian.net, with or without
 * https:// or a trailing /wiki) and returns the canonical base, or null for
 * something that cannot be a site URL.
 */
export function normalizeSiteUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname.includes('.')) return null;
  const path = url.pathname.replace(/\/(wiki)?\/?$/i, '');
  return `${url.protocol}//${url.host}${path}`;
}

export interface SpaceInfo {
  id: string;
  key: string;
  name: string;
  type: string;
}

/** One v1 CQL search result, pre-flattened to what the descriptor needs. */
export interface SearchResultItem {
  id: string;
  type: 'page' | 'attachment';
  title: string;
  /** version.number, the incrementing change marker the dedup rides on. */
  version: number | null;
  /** version.when, the last-modified instant. */
  modifiedAt: string | null;
  spaceKey: string | null;
  spaceName: string | null;
  spaceType: string | null;
  /** Nearest ancestor's title and id (pages only). */
  parentId: string | null;
  parentTitle: string | null;
  /** The containing page (attachments only). */
  containerId: string | null;
  containerTitle: string | null;
  mediaType: string | null;
  fileSize: number | null;
  /** Site-relative download path (attachments only). */
  downloadPath: string | null;
  /** Site-relative web link. */
  webuiPath: string | null;
}

export interface PageBody {
  id: string;
  title: string;
  version: number;
  spaceId: string | null;
  parentId: string | null;
  /** Storage-format XHTML. */
  storage: string;
  webuiPath: string | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The one client. Every method is a read; every request goes through the
 * single `get` helper below.
 */
export class ConfluenceClient {
  constructor(
    private readonly auth: ConfluenceAuth,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * THE request helper: the only place in the confluence module that talks
   * HTTP, and the method is a constant. read-only.spec.ts asserts both.
   */
  private async get(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<{ status: number; json: unknown; contentType: string }> {
    const url = new URL(`${this.auth.siteUrl}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const basic = Buffer.from(`${this.auth.email}:${this.auth.apiToken}`, 'utf8').toString(
      'base64',
    );
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { authorization: `Basic ${basic}`, accept: 'application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ConfluenceUnreachableError((error as Error).message);
    }
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ConfluenceHttpError(
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      // A login page or a proxy answered: this is not the Confluence API.
      throw new ConfluenceNotAConfluenceError();
    }
    return { status: response.status, json: await response.json(), contentType };
  }

  /** The raw-bytes variant of the SAME helper, for attachment downloads. */
  private async getBytes(path: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const url = new URL(`${this.auth.siteUrl}${path}`);
    const basic = Buffer.from(`${this.auth.email}:${this.auth.apiToken}`, 'utf8').toString(
      'base64',
    );
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { authorization: `Basic ${basic}` },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ConfluenceUnreachableError((error as Error).message);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new ConfluenceHttpError(
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  /** The spaces the account can see, one page of them. */
  async listSpaces(cursor?: string | null): Promise<{ spaces: SpaceInfo[]; next: string | null }> {
    const { json } = cursor
      ? await this.get(cursor)
      : await this.get('/wiki/api/v2/spaces', { limit: 100, sort: 'name' });
    const body = json as {
      results?: { id?: unknown; key?: unknown; name?: unknown; type?: unknown }[];
      _links?: { next?: unknown };
    };
    const spaces = (body.results ?? [])
      .filter((s) => s.id !== undefined && typeof s.key === 'string')
      .map((s) => ({
        id: String(s.id),
        key: String(s.key),
        name: typeof s.name === 'string' ? s.name : String(s.key),
        type: typeof s.type === 'string' ? s.type : 'global',
      }));
    const next = typeof body._links?.next === 'string' ? body._links.next : null;
    return { spaces, next };
  }

  /** Numeric space id for a key (v2 needs ids, CQL wants keys). */
  async spaceIdForKey(key: string): Promise<string | null> {
    const { json } = await this.get('/wiki/api/v2/spaces', { keys: key, limit: 1 });
    const body = json as { results?: { id?: unknown }[] };
    const id = body.results?.[0]?.id;
    return id === undefined ? null : String(id);
  }

  /**
   * One page of a CQL content search, newest-modified first, flattened.
   * `cursorPath` is the previous page's `_links.next` (site-relative).
   */
  async searchContent(
    cql: string,
    options: { cursorPath?: string | null; limit?: number } = {},
  ): Promise<{ items: SearchResultItem[]; next: string | null }> {
    const { json } = options.cursorPath
      ? await this.get(`/wiki${options.cursorPath.replace(/^\/wiki/, '')}`)
      : await this.get('/wiki/rest/api/content/search', {
          cql,
          limit: options.limit ?? 50,
          expand: 'version,space,ancestors,container,extensions,metadata',
        });
    const body = json as { results?: unknown[]; _links?: { next?: unknown } };
    const items = (body.results ?? [])
      .map((raw) => flattenSearchResult(raw))
      .filter((item): item is SearchResultItem => item !== null);
    const next = typeof body._links?.next === 'string' ? body._links.next : null;
    return { items, next };
  }

  /** How many results a CQL matches: the honest backfill estimate. */
  async countSearch(cql: string): Promise<number | null> {
    const { json } = await this.get('/wiki/rest/api/search', { cql, limit: 1 });
    const body = json as { totalSize?: unknown };
    return typeof body.totalSize === 'number' ? body.totalSize : null;
  }

  /** The page's current storage-format body; null when gone or unseeable. */
  async getPageBody(pageId: string): Promise<PageBody | null> {
    let json: unknown;
    try {
      ({ json } = await this.get(`/wiki/api/v2/pages/${pageId}`, {
        'body-format': 'storage',
      }));
    } catch (error) {
      if (error instanceof ConfluenceHttpError && error.status === 404) return null;
      throw error;
    }
    const body = json as {
      id?: unknown;
      title?: unknown;
      version?: { number?: unknown };
      spaceId?: unknown;
      parentId?: unknown;
      body?: { storage?: { value?: unknown } };
      _links?: { webui?: unknown };
    };
    if (body.id === undefined) return null;
    return {
      id: String(body.id),
      title: typeof body.title === 'string' ? body.title : '',
      version: typeof body.version?.number === 'number' ? body.version.number : 0,
      spaceId: body.spaceId === undefined ? null : String(body.spaceId),
      parentId:
        body.parentId === undefined || body.parentId === null ? null : String(body.parentId),
      storage: typeof body.body?.storage?.value === 'string' ? body.body.storage.value : '',
      webuiPath: typeof body._links?.webui === 'string' ? body._links.webui : null,
    };
  }

  /** A page title alone (breadcrumbs); null when gone or unseeable. */
  async getPageTitle(pageId: string): Promise<string | null> {
    let json: unknown;
    try {
      ({ json } = await this.get(`/wiki/api/v2/pages/${pageId}`));
    } catch (error) {
      if (error instanceof ConfluenceHttpError && error.status === 404) return null;
      throw error;
    }
    const body = json as { title?: unknown };
    return typeof body.title === 'string' ? body.title : null;
  }

  /**
   * Whether the content carries view restrictions beyond the space's own:
   * restricted-to-a-subset content is skipped and reported (spec 4.4.4).
   */
  async hasReadRestrictions(contentId: string): Promise<boolean> {
    let json: unknown;
    try {
      ({ json } = await this.get(
        `/wiki/rest/api/content/${contentId}/restriction/byOperation/read`,
      ));
    } catch (error) {
      // A page whose restrictions cannot be read is treated as restricted:
      // failing open would materialize content we could not check.
      if (error instanceof ConfluenceHttpError && error.status === 404) return true;
      throw error;
    }
    const body = json as {
      restrictions?: {
        user?: { results?: unknown[] };
        group?: { results?: unknown[] };
      };
    };
    const users = body.restrictions?.user?.results?.length ?? 0;
    const groups = body.restrictions?.group?.results?.length ?? 0;
    return users + groups > 0;
  }

  /** One page of page IDS for a space (presence sweep; identifiers only). */
  async listPageIds(
    spaceId: string,
    status: 'current' | 'archived',
    cursorPath?: string | null,
  ): Promise<{ ids: string[]; next: string | null }> {
    const { json } = cursorPath
      ? await this.get(cursorPath)
      : await this.get(`/wiki/api/v2/spaces/${spaceId}/pages`, { limit: 250, status });
    const body = json as { results?: { id?: unknown }[]; _links?: { next?: unknown } };
    const ids = (body.results ?? []).filter((p) => p.id !== undefined).map((p) => String(p.id));
    const next = typeof body._links?.next === 'string' ? body._links.next : null;
    return { ids, next };
  }

  /** Attachment bytes; null when gone. The download path is site-relative. */
  async downloadAttachment(
    downloadPath: string,
  ): Promise<{ bytes: Buffer; contentType: string } | null> {
    const path = downloadPath.startsWith('/wiki') ? downloadPath : `/wiki${downloadPath}`;
    return this.getBytes(path);
  }
}

function flattenSearchResult(raw: unknown): SearchResultItem | null {
  const r = raw as {
    id?: unknown;
    type?: unknown;
    title?: unknown;
    version?: { number?: unknown; when?: unknown };
    space?: { key?: unknown; name?: unknown; type?: unknown };
    ancestors?: { id?: unknown; title?: unknown }[];
    container?: { id?: unknown; title?: unknown };
    extensions?: { mediaType?: unknown; fileSize?: unknown };
    _links?: { download?: unknown; webui?: unknown };
  };
  if (r.id === undefined || (r.type !== 'page' && r.type !== 'attachment')) return null;
  const ancestors = r.ancestors ?? [];
  const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined;
  return {
    id: String(r.id),
    type: r.type,
    title: typeof r.title === 'string' ? r.title : '',
    version: typeof r.version?.number === 'number' ? r.version.number : null,
    modifiedAt: typeof r.version?.when === 'string' ? r.version.when : null,
    spaceKey: typeof r.space?.key === 'string' ? r.space.key : null,
    spaceName: typeof r.space?.name === 'string' ? r.space.name : null,
    spaceType: typeof r.space?.type === 'string' ? r.space.type : null,
    parentId: parent?.id === undefined ? null : String(parent.id),
    parentTitle: typeof parent?.title === 'string' ? parent.title : null,
    containerId: r.container?.id === undefined ? null : String(r.container.id),
    containerTitle: typeof r.container?.title === 'string' ? r.container.title : null,
    mediaType: typeof r.extensions?.mediaType === 'string' ? r.extensions.mediaType : null,
    fileSize: typeof r.extensions?.fileSize === 'number' ? r.extensions.fileSize : null,
    downloadPath: typeof r._links?.download === 'string' ? r._links.download : null,
    webuiPath: typeof r._links?.webui === 'string' ? r._links.webui : null,
  };
}
