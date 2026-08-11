import { describe, expect, it } from 'vitest';
import { DEFAULT_UPLOAD_MAX_BYTES } from '@cogeto/shared';
import type { ConnectorDescriptor, ConnectorSecrets, UpstreamItem } from '../connectors/index';
import { breadcrumbFilename, confluenceConnector } from './descriptor';
import { FakeConfluenceSite } from './testing/fake-site';

/**
 * The descriptor against the in-memory site (V2.5 item 8.2, issues B, C,
 * D): the sub-scope grammar, version-hash change detection with LAZY
 * content (the zero-cost property's mechanism), the attachments toggle,
 * and the incremental watermark with its day of slack.
 */

const SECRETS: ConnectorSecrets = {
  accessToken: 'tok-1',
  extras: { siteUrl: 'https://confluence.fake', email: 'user@example.com' },
};

function makeSite(): { site: FakeConfluenceSite; descriptor: ConnectorDescriptor } {
  const site = new FakeConfluenceSite();
  site.addSpace('ENG', 'Engineering');
  site.addSpace('HR', 'People Ops');
  site.putPage({
    id: '100',
    spaceKey: 'ENG',
    title: 'Platform',
    body: '<h1>Platform</h1><p>The platform overview.</p>',
    modifiedAt: '2026-08-01T10:00:00.000Z',
  });
  site.putPage({
    id: '101',
    spaceKey: 'ENG',
    title: 'Sync Engine',
    parentId: '100',
    body: '<h2>Limits</h2><p>The sync target is <strong>3.2 mm</strong>.</p>',
    modifiedAt: '2026-08-02T10:00:00.000Z',
  });
  site.putPage({
    id: '102',
    spaceKey: 'ENG',
    title: 'Roadmap',
    body: '<p>Two phases planned.</p>',
    modifiedAt: '2026-08-03T10:00:00.000Z',
  });
  return { site, descriptor: confluenceConnector({ fetchImpl: site.handler }) };
}

/** Pages through fetchPage the way the engine does, to listing completion. */
async function listAll(
  descriptor: ConnectorDescriptor,
  subScope: string,
  options: { cursor?: unknown; since?: Date | null; scopeSettings?: unknown } = {},
): Promise<{ items: UpstreamItem[]; cursor: unknown }> {
  let cursor = options.cursor ?? null;
  const items: UpstreamItem[] = [];
  for (let i = 0; i < 20; i += 1) {
    const page = await descriptor.fetchPage(SECRETS, {
      subScope,
      cursor,
      limit: 50,
      since: options.since ?? null,
      scopeSettings: options.scopeSettings ?? null,
    });
    items.push(...page.items);
    cursor = page.cursor;
    if (page.done) return { items, cursor };
  }
  throw new Error('the fake listing never completed');
}

function itemByKey(items: UpstreamItem[], naturalKey: string): UpstreamItem {
  const item = items.find((i) => i.naturalKey === naturalKey);
  if (!item) throw new Error(`no listed item ${naturalKey}`);
  return item;
}

async function resolveLazy(item: UpstreamItem) {
  if (typeof item.content !== 'function') throw new Error('expected lazy content');
  return item.content();
}

describe('sub-scope key grammar', () => {
  it('accepts_a_page_subtree_key_and_nothing_else', () => {
    const { descriptor } = makeSite();
    expect(descriptor.acceptSubScopeKey!('page:123')).toBe(true);
    expect(descriptor.acceptSubScopeKey!('space:ENG')).toBe(false);
    expect(descriptor.acceptSubScopeKey!('page:abc')).toBe(false);
    expect(descriptor.acceptSubScopeKey!('page:')).toBe(false);
    expect(descriptor.acceptSubScopeKey!('page:1 or 1=1')).toBe(false);
    expect(descriptor.acceptSubScopeKey!('junk')).toBe(false);
  });
});

describe('listSubScopes', () => {
  it('maps_spaces_to_space_keys_with_name_and_key_labels', async () => {
    const { descriptor } = makeSite();
    const scopes = await descriptor.listSubScopes!(SECRETS);
    expect(scopes).toEqual([
      { key: 'space:ENG', label: 'Engineering (ENG)' },
      { key: 'space:HR', label: 'People Ops (HR)' },
    ]);
  });
});

describe('lazy pages and the version hash', () => {
  it('lists_pages_without_fetching_a_single_body_and_hashes_id_plus_version', async () => {
    const { site, descriptor } = makeSite();
    const first = await listAll(descriptor, 'space:ENG');
    expect(first.items.map((i) => i.naturalKey).sort()).toEqual([
      'conf:page:100',
      'conf:page:101',
      'conf:page:102',
    ]);
    expect(site.bodyFetches).toBe(0);

    // Same version twice: the hash is identical, so the ledger skips.
    const again = await listAll(descriptor, 'space:ENG');
    expect(itemByKey(again.items, 'conf:page:101').contentHash).toBe(
      itemByKey(first.items, 'conf:page:101').contentHash,
    );

    // A version bump changes the hash; untouched pages keep theirs.
    site.editPage('101', '<p>The sync target is 3.4 mm.</p>');
    const after = await listAll(descriptor, 'space:ENG');
    expect(itemByKey(after.items, 'conf:page:101').contentHash).not.toBe(
      itemByKey(first.items, 'conf:page:101').contentHash,
    );
    expect(itemByKey(after.items, 'conf:page:101').upstreamRevision).toBe('2');
    expect(itemByKey(after.items, 'conf:page:100').contentHash).toBe(
      itemByKey(first.items, 'conf:page:100').contentHash,
    );
    expect(site.bodyFetches).toBe(0);
  });

  it('resolving_the_lazy_content_converts_storage_format_under_a_breadcrumb_filename', async () => {
    const { site, descriptor } = makeSite();
    const { items } = await listAll(descriptor, 'space:ENG');
    const resolved = await resolveLazy(itemByKey(items, 'conf:page:101'));
    expect(site.bodyFetches).toBe(1);
    if (resolved === null || resolved === 'restricted') throw new Error('expected content');
    expect(resolved.filename).toBe('Engineering / Platform / Sync Engine.md');
    expect(resolved.contentType).toBe('text/markdown');
    expect(resolved.bytes.toString('utf8')).toBe('## Limits\n\nThe sync target is 3.2 mm.');
  });

  it('a_restricted_page_resolves_to_restricted_before_any_body_is_fetched', async () => {
    const { site, descriptor } = makeSite();
    const { items } = await listAll(descriptor, 'space:ENG');
    site.restrict('102');
    expect(await resolveLazy(itemByKey(items, 'conf:page:102'))).toBe('restricted');
    expect(site.bodyFetches).toBe(0);
  });

  it('a_page_deleted_between_listing_and_fetch_resolves_to_null', async () => {
    const { site, descriptor } = makeSite();
    const { items } = await listAll(descriptor, 'space:ENG');
    site.deletePage('101');
    expect(await resolveLazy(itemByKey(items, 'conf:page:101'))).toBeNull();
  });
});

describe('the attachments toggle', () => {
  it('emits_supported_size_capped_attachments_only_when_the_scope_opted_in', async () => {
    const { site, descriptor } = makeSite();
    site.putAttachment({
      id: '900',
      pageId: '100',
      title: 'handbook.pdf',
      mediaType: 'application/pdf',
      fileSize: 2048,
      modifiedAt: '2026-08-04T10:00:00.000Z',
    });
    site.putAttachment({
      id: '901',
      pageId: '100',
      title: 'demo.mp4',
      mediaType: 'video/mp4',
      modifiedAt: '2026-08-04T10:00:00.000Z',
    });
    site.putAttachment({
      id: '902',
      pageId: '100',
      title: 'huge.pdf',
      mediaType: 'application/pdf',
      fileSize: DEFAULT_UPLOAD_MAX_BYTES + 1,
      modifiedAt: '2026-08-04T10:00:00.000Z',
    });

    const off = await listAll(descriptor, 'space:ENG');
    expect(off.items.some((i) => i.naturalKey.startsWith('conf:att:'))).toBe(false);

    const on = await listAll(descriptor, 'space:ENG', { scopeSettings: { attachments: true } });
    const attachmentKeys = on.items
      .map((i) => i.naturalKey)
      .filter((k) => k.startsWith('conf:att:'));
    expect(attachmentKeys).toEqual(['conf:att:900']);
    expect(site.attachmentDownloads).toBe(0); // listing never downloads

    const resolved = await resolveLazy(itemByKey(on.items, 'conf:att:900'));
    if (resolved === null || resolved === 'restricted') throw new Error('expected content');
    expect(resolved.filename).toBe('handbook.pdf');
    expect(resolved.contentType).toBe('application/pdf');
    expect(site.attachmentDownloads).toBe(1);
  });
});

describe('a page-rooted sub-scope', () => {
  it('lists_the_root_and_its_descendants_only', async () => {
    const { descriptor } = makeSite();
    const { items } = await listAll(descriptor, 'page:100');
    expect(items.map((i) => i.naturalKey).sort()).toEqual(['conf:page:100', 'conf:page:101']);
  });
});

describe('the incremental watermark', () => {
  it('promotes_the_newest_modification_only_when_the_listing_completes', async () => {
    const { descriptor } = makeSite();
    const first = await descriptor.fetchPage(SECRETS, {
      subScope: 'space:ENG',
      cursor: null,
      limit: 50,
      since: null,
      scopeSettings: null,
    });
    expect(first.done).toBe(false);
    const midway = first.cursor as { watermark: string | null; pendingWatermark: string | null };
    expect(midway.watermark).toBeNull();
    expect(midway.pendingWatermark).toBe('2026-08-03T10:00:00.000Z');

    const { cursor } = await listAll(descriptor, 'space:ENG', { cursor: first.cursor });
    expect((cursor as { watermark: string | null }).watermark).toBe('2026-08-03T10:00:00.000Z');
  });

  it('the_next_fetch_relists_from_one_day_before_the_watermark', async () => {
    const { site, descriptor } = makeSite();
    const { cursor } = await listAll(descriptor, 'space:ENG');
    await descriptor.fetchPage(SECRETS, {
      subScope: 'space:ENG',
      cursor,
      limit: 50,
      since: null,
      scopeSettings: null,
    });
    // Watermark 2026-08-03T10:00Z minus the day of slack: CQL dates are
    // day-granular in the site's timezone, so the overlap is deliberate.
    expect(site.lastCql).toContain('lastmodified >= "2026/08/02"');
    expect(site.lastCql).toContain('order by lastmodified desc');
  });
});

describe('breadcrumbFilename', () => {
  it('joins_present_parts_and_always_ends_in_md', () => {
    expect(breadcrumbFilename(['Engineering', 'Platform', 'Sync Engine'])).toBe(
      'Engineering / Platform / Sync Engine.md',
    );
    expect(breadcrumbFilename(['Engineering', null, 'Roadmap'])).toBe('Engineering / Roadmap.md');
    expect(breadcrumbFilename([undefined, '  ', null])).toBe('untitled.md');
  });

  it('collapses_whitespace_and_caps_long_input_keeping_the_tail', () => {
    expect(breadcrumbFilename(['A  B\nC'])).toBe('A B C.md');
    const long = breadcrumbFilename(['x'.repeat(300)]);
    expect(long).toBe(`${'x'.repeat(180)}.md`);
  });
});
