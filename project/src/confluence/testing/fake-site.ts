/**
 * An in-memory Confluence Cloud site for the confluence specs (V2.5 item
 * 8.2, authoring guide step 5): exactly the read endpoints the client uses,
 * behind a fetch-compatible handler, with counters for every touch that
 * costs something upstream. Test-only, the reference-connector precedent;
 * read-only.spec.ts scans this file too, so nothing here may name an HTTP
 * surface of its own.
 */

export interface FakeSpace {
  id: string;
  key: string;
  name: string;
  type: string;
}

export interface FakePage {
  id: string;
  spaceKey: string;
  title: string;
  parentId: string | null;
  version: number;
  modifiedAt: string;
  body: string;
  status: 'current' | 'archived' | 'deleted';
}

export interface FakeAttachment {
  id: string;
  pageId: string;
  title: string;
  mediaType: string;
  fileSize: number;
  version: number;
  modifiedAt: string;
  bytes: Buffer;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export class FakeConfluenceSite {
  readonly baseUrl = 'https://confluence.fake';
  /** Results per search page, small so listings paginate like the real API. */
  searchPageSize = 2;

  private spaces: FakeSpace[] = [];
  private pages = new Map<string, FakePage>();
  private attachments = new Map<string, FakeAttachment>();
  private restrictedIds = new Set<string>();
  private nextSpaceId = 10001;

  /** Counters the specs assert against. */
  requests = 0;
  searchCalls = 0;
  countCalls = 0;
  bodyFetches = 0;
  attachmentDownloads = 0;
  lastCql: string | null = null;

  /** The fetch-compatible entry the specs inject into the client. */
  handler: typeof globalThis.fetch = async (input) => this.handle(String(input));

  addSpace(key: string, name: string, type = 'global'): FakeSpace {
    const space = { id: String(this.nextSpaceId++), key, name, type };
    this.spaces.push(space);
    return space;
  }

  putPage(input: {
    id: string;
    spaceKey: string;
    title: string;
    parentId?: string | null;
    body?: string;
    version?: number;
    modifiedAt?: string;
  }): void {
    this.pages.set(input.id, {
      id: input.id,
      spaceKey: input.spaceKey,
      title: input.title,
      parentId: input.parentId ?? null,
      body: input.body ?? '',
      version: input.version ?? 1,
      modifiedAt: input.modifiedAt ?? new Date().toISOString(),
      status: 'current',
    });
  }

  /** An upstream edit: the version increments, as Confluence guarantees. */
  editPage(id: string, body: string, modifiedAt = new Date().toISOString()): number {
    const page = this.mustPage(id);
    page.body = body;
    page.version += 1;
    page.modifiedAt = modifiedAt;
    return page.version;
  }

  deletePage(id: string): void {
    this.mustPage(id).status = 'deleted';
  }

  archivePage(id: string): void {
    this.mustPage(id).status = 'archived';
  }

  restorePage(id: string): void {
    this.mustPage(id).status = 'current';
  }

  restrict(id: string): void {
    this.restrictedIds.add(id);
  }

  putAttachment(input: {
    id: string;
    pageId: string;
    title: string;
    mediaType: string;
    fileSize?: number;
    version?: number;
    modifiedAt?: string;
    bytes?: Buffer;
  }): void {
    this.attachments.set(input.id, {
      id: input.id,
      pageId: input.pageId,
      title: input.title,
      mediaType: input.mediaType,
      fileSize: input.fileSize ?? 1024,
      version: input.version ?? 1,
      modifiedAt: input.modifiedAt ?? new Date().toISOString(),
      bytes: input.bytes ?? Buffer.from('%PDF-1.4 fake attachment bytes', 'utf8'),
    });
  }

  private mustPage(id: string): FakePage {
    const page = this.pages.get(id);
    if (!page) throw new Error(`no such fake page: ${id}`);
    return page;
  }

  private spaceOf(key: string): { key: string; name: string; type: string } | null {
    const space = this.spaces.find((s) => s.key === key);
    return space ? { key: space.key, name: space.name, type: space.type } : null;
  }

  private webuiOf(page: FakePage): string {
    return `/spaces/${page.spaceKey}/pages/${page.id}`;
  }

  private ancestors(page: FakePage): { id: string; title: string }[] {
    const chain: { id: string; title: string }[] = [];
    let parent = page.parentId ? this.pages.get(page.parentId) : undefined;
    while (parent) {
      chain.unshift({ id: parent.id, title: parent.title });
      parent = parent.parentId ? this.pages.get(parent.parentId) : undefined;
    }
    return chain;
  }

  private ancestorIds(page: FakePage): string[] {
    return this.ancestors(page).map((a) => a.id);
  }

  private async handle(rawUrl: string): Promise<Response> {
    this.requests += 1;
    const url = new URL(rawUrl);
    const path = url.pathname;

    if (path === '/wiki/api/v2/spaces') {
      const keys = url.searchParams.get('keys');
      const results = this.spaces
        .filter((s) => keys === null || keys.split(',').includes(s.key))
        .map((s) => ({ id: s.id, key: s.key, name: s.name, type: s.type }));
      return json({ results, _links: {} });
    }

    const spacePages = /^\/wiki\/api\/v2\/spaces\/([^/]+)\/pages$/.exec(path);
    if (spacePages) {
      const status = url.searchParams.get('status') ?? 'current';
      const space = this.spaces.find((s) => s.id === spacePages[1]);
      const results = space
        ? [...this.pages.values()]
            .filter((p) => p.spaceKey === space.key && p.status === status)
            .map((p) => ({ id: p.id }))
        : [];
      return json({ results, _links: {} });
    }

    const pageById = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(path);
    if (pageById) {
      this.bodyFetches += 1;
      const page = this.pages.get(pageById[1]!);
      if (!page || page.status === 'deleted') return json({}, 404);
      const space = this.spaces.find((s) => s.key === page.spaceKey);
      return json({
        id: page.id,
        title: page.title,
        version: { number: page.version },
        spaceId: space?.id ?? null,
        parentId: page.parentId,
        body: { storage: { value: page.body } },
        _links: { webui: this.webuiOf(page) },
      });
    }

    const restriction = /^\/wiki\/rest\/api\/content\/(\d+)\/restriction\/byOperation\/read$/.exec(
      path,
    );
    if (restriction) {
      const restricted = this.restrictedIds.has(restriction[1]!);
      return json({
        restrictions: {
          user: { results: restricted ? [{ type: 'known' }] : [] },
          group: { results: [] },
        },
      });
    }

    if (path === '/wiki/rest/api/content/search') {
      this.searchCalls += 1;
      const cql = url.searchParams.get('cql') ?? '';
      this.lastCql = cql;
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const all = this.searchResults(cql);
      const page = all.slice(offset, offset + this.searchPageSize);
      const nextOffset = offset + page.length;
      const next =
        nextOffset < all.length
          ? `/rest/api/content/search?cql=${encodeURIComponent(cql)}&cursor=${nextOffset}`
          : null;
      return json({ results: page, _links: next ? { next } : {} });
    }

    if (path === '/wiki/rest/api/search') {
      this.countCalls += 1;
      const cql = url.searchParams.get('cql') ?? '';
      this.lastCql = cql;
      return json({ totalSize: this.searchResults(cql).length });
    }

    if (path.startsWith('/wiki/download/attachments/')) {
      const attachment = [...this.attachments.values()].find((a) => path.endsWith(`/${a.id}`));
      if (!attachment) return json({}, 404);
      this.attachmentDownloads += 1;
      return new Response(new Uint8Array(attachment.bytes), {
        status: 200,
        headers: { 'content-type': attachment.mediaType },
      });
    }

    return json({ message: `no such route: ${path}` }, 404);
  }

  /** Enough CQL for the clauses the descriptor and the estimate build. */
  private searchResults(cql: string): unknown[] {
    const spaceMatch = /space = "([^"]+)"/.exec(cql);
    const subtree = /\(id = (\d+) or ancestor = (\d+)\)/.exec(cql);
    const both = cql.includes('(page, attachment)');
    const wantsPages = both || /type = page/.test(cql);
    const wantsAttachments = both || /type = attachment/.test(cql);
    const dateMatch = /lastmodified >= "(\d{4})\/(\d{2})\/(\d{2})"/.exec(cql);
    const bound = dateMatch
      ? Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]))
      : null;
    const inWindow = (modifiedAt: string): boolean =>
      bound === null || Date.parse(modifiedAt) >= bound;

    const entries: { modifiedAt: string; id: string; raw: unknown }[] = [];
    if (wantsPages) {
      for (const page of this.pages.values()) {
        if (page.status !== 'current') continue;
        if (spaceMatch && page.spaceKey !== spaceMatch[1]) continue;
        if (subtree && page.id !== subtree[1] && !this.ancestorIds(page).includes(subtree[2]!)) {
          continue;
        }
        if (!inWindow(page.modifiedAt)) continue;
        entries.push({
          modifiedAt: page.modifiedAt,
          id: page.id,
          raw: {
            id: page.id,
            type: 'page',
            title: page.title,
            version: { number: page.version, when: page.modifiedAt },
            space: this.spaceOf(page.spaceKey),
            ancestors: this.ancestors(page),
            _links: { webui: this.webuiOf(page) },
          },
        });
      }
    }
    if (wantsAttachments && !subtree) {
      for (const attachment of this.attachments.values()) {
        const page = this.pages.get(attachment.pageId);
        if (!page || page.status !== 'current') continue;
        if (spaceMatch && page.spaceKey !== spaceMatch[1]) continue;
        if (!inWindow(attachment.modifiedAt)) continue;
        entries.push({
          modifiedAt: attachment.modifiedAt,
          id: attachment.id,
          raw: {
            id: attachment.id,
            type: 'attachment',
            title: attachment.title,
            version: { number: attachment.version, when: attachment.modifiedAt },
            space: this.spaceOf(page.spaceKey),
            container: { id: page.id, title: page.title },
            extensions: { mediaType: attachment.mediaType, fileSize: attachment.fileSize },
            _links: {
              download: `/download/attachments/${page.id}/${attachment.id}`,
              webui: `${this.webuiOf(page)}?attachment=${attachment.id}`,
            },
          },
        });
      }
    }
    entries.sort((a, b) =>
      a.modifiedAt === b.modifiedAt
        ? b.id.localeCompare(a.id)
        : Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt),
    );
    return entries.map((e) => e.raw);
  }
}
