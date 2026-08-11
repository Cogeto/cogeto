import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { ConnectorCredentialOpener, ConnectorCredentialStore } from '../identity/index';
import type { IdentityOptions } from '../identity/index';
import { SourceRevisionStore } from '../ingestion/index';
import type { FilesService } from '../files/index';
import {
  ConnectorItemLedger,
  ConnectorPresenceSweep,
  ConnectorRegistry,
  ConnectorStore,
  ConnectorSyncEngine,
} from '../connectors/index';
import { CONFLUENCE_KIND, confluenceConnector } from './descriptor';
import { ConfluenceEstimateService } from './estimate';
import { ConfluencePageStore } from './persistence/page-store';
import { confluencePage } from './persistence/tables';
import { FakeConfluenceSite } from './testing/fake-site';

/**
 * The Confluence connector through the REAL platform (V2.5 item 8.2,
 * authoring guide step 5): the harness every connector validates against,
 * with the confluence descriptor over an in-memory site. The FakeFiles
 * upload count is the model-cost proxy exactly as in the platform harness,
 * and the site's bodyFetches counter proves the STRONGER half of the
 * overriding constraint: an unchanged page is skipped before its content is
 * fetched, not merely before it is extracted.
 */

const OWNER = 'user-confluence';
const ORG = 'org-confluence';
const MASTER_KEY = randomBytes(32);

const principal: Principal = {
  userId: OWNER,
  name: 'Confluence Tester',
  email: null,
  orgId: ORG,
  orgName: '',
  roles: [],
};

const identityOptions: IdentityOptions = {
  internalBaseUrl: 'http://zitadel.invalid',
  externalDomain: 'localhost',
  cacheTtlSeconds: 1,
  masterKey: MASTER_KEY,
  credentialReads: true,
};

/** The upload seam: mints keys and counts calls (the model-cost proxy). */
class FakeFiles {
  uploads: { name: string; scope: string }[] = [];

  async upload(
    principal: Principal,
    file: { buffer: Buffer; originalName: string; mimeType: string },
    flags: { scope: 'private' | 'shared'; sensitive: boolean; discard: boolean },
  ): Promise<{ objectKey: string }> {
    const objectKey = `${ORG}/${principal.userId}/${flags.scope}/file-${this.uploads.length}-${file.originalName}`;
    this.uploads.push({ name: file.originalName, scope: flags.scope });
    return { objectKey };
  }
}

const iso = (minutesAgo: number): string =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

describe('confluence_connector (platform harness)', () => {
  let tdb: TestDatabase;
  let site: FakeConfluenceSite;
  let registry: ConnectorRegistry;
  let store: ConnectorStore;
  let ledger: ConnectorItemLedger;
  let credentials: ConnectorCredentialStore;
  let opener: ConnectorCredentialOpener;
  let revisions: SourceRevisionStore;
  let pageStore: ConfluencePageStore;
  let files: FakeFiles;
  let engine: ConnectorSyncEngine;
  let row: Awaited<ReturnType<ConnectorStore['create']>>;

  /** The confluence rate profile (burst 10, 2 rps) is tuned for a live
   * site; a spec would otherwise spend real seconds on refill, so each
   * advance starts from a full bucket. Retry-After walls are never set in
   * this suite, so clearing the state loses nothing. */
  async function topUpBucket(): Promise<void> {
    await store.saveRateState(row.id, 'connector', {
      tokens: 10,
      refilledAt: new Date(),
      retryAfterUntil: null,
    });
  }

  /** Advance passes until the connector settles, refilling the bucket the
   * way elapsed wall-clock time would. */
  async function settle(maxPasses = 40): Promise<void> {
    for (let i = 0; i < maxPasses; i += 1) {
      await topUpBucket();
      await engine.advance(row.id);
      const fresh = await store.byId(row.id);
      if (!fresh) return;
      if (
        fresh.state === 'healthy' ||
        fresh.state === 'needs_reauth' ||
        fresh.state === 'degraded'
      ) {
        return;
      }
      const paused = fresh.settingsJson?.pausedReason ?? null;
      if (paused && paused !== 'rate_limited') return;
    }
    throw new Error('the connector did not settle');
  }

  async function sourceRefOf(
    naturalKey: string,
  ): Promise<{ sourceType: string; sourceId: string }> {
    const item = await ledger.byNaturalKey(row.id, naturalKey);
    if (!item?.sourceType || !item.sourceId) throw new Error(`no source for ${naturalKey}`);
    return { sourceType: item.sourceType, sourceId: item.sourceId };
  }

  beforeAll(async () => {
    tdb = await startTestDatabase();
    site = new FakeConfluenceSite();
    site.addSpace('ENG', 'Engineering');
    site.addSpace('HR', 'People Ops');
    site.putPage({
      id: '100',
      spaceKey: 'ENG',
      title: 'Platform',
      body: '<h1>Platform</h1><p>The platform overview.</p>',
      modifiedAt: iso(300),
    });
    site.putPage({
      id: '101',
      spaceKey: 'ENG',
      title: 'Sync Engine',
      parentId: '100',
      body: '<p>The sync interval is 15 minutes.</p>',
      modifiedAt: iso(290),
    });
    site.putPage({
      id: '102',
      spaceKey: 'ENG',
      title: 'Roadmap',
      body: '<p>Two phases planned.</p>',
      modifiedAt: iso(280),
    });

    registry = new ConnectorRegistry([confluenceConnector({ fetchImpl: site.handler })]);
    store = new ConnectorStore(tdb.db, { masterKey: MASTER_KEY });
    ledger = new ConnectorItemLedger(tdb.db);
    credentials = new ConnectorCredentialStore(tdb.db, identityOptions);
    opener = new ConnectorCredentialOpener(tdb.db, identityOptions);
    revisions = new SourceRevisionStore(tdb.db);
    pageStore = new ConfluencePageStore(tdb.db);
    files = new FakeFiles();
    engine = new ConnectorSyncEngine(
      tdb.db,
      registry,
      store,
      ledger,
      credentials,
      revisions,
      opener,
      files as unknown as FilesService,
    );
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  it('connect: credential sealed, discovery offers the spaces, nothing fetched beyond discovery', async () => {
    row = await store.create({
      ownerId: OWNER,
      orgId: ORG,
      kind: CONFLUENCE_KIND,
      name: 'Team Confluence',
    });
    await credentials.store(tdb.db, {
      ownerId: OWNER,
      orgId: ORG,
      connectorId: row.id,
      material: {
        accessToken: 'token',
        extras: { siteUrl: site.baseUrl, email: 'owner@example.com' },
      },
      accountIdentity: `owner@example.com on ${site.baseUrl}`,
      scopes: ['read'],
      expiresAt: null,
    });
    await store.transition(tdb.db, row, 'authorised', { actor: `user:${OWNER}` });

    await topUpBucket();
    await engine.advance(row.id);

    const scopes = await store.subScopes(row.id);
    expect(scopes.map((s) => s.key).sort()).toEqual(['space:ENG', 'space:HR']);
    expect(scopes.find((s) => s.key === 'space:ENG')?.label).toBe('Engineering (ENG)');
    expect(scopes.every((s) => !s.selected)).toBe(true);
    expect(site.searchCalls).toBe(0);
    expect(site.bodyFetches).toBe(0);
    expect(files.uploads).toHaveLength(0);
  });

  it('a_selected_space_materializes_its_pages_under_breadcrumb_filenames_with_provenance', async () => {
    await store.setSubScopeSelection(row, 'space:ENG', { selected: true });
    await settle();

    expect(files.uploads.map((u) => u.name).sort()).toEqual([
      'Engineering / Platform / Sync Engine.md',
      'Engineering / Platform.md',
      'Engineering / Roadmap.md',
    ]);
    expect(files.uploads.every((u) => u.scope === 'shared')).toBe(true);
    expect((await store.byId(row.id))?.state).toBe('healthy');

    // The ledger's natural keys are the container-independent page ids.
    for (const key of ['conf:page:100', 'conf:page:101', 'conf:page:102']) {
      const item = await ledger.byNaturalKey(row.id, key);
      expect(item?.state).toBe('active');
      expect(item?.sourceType).toBe('file');
    }

    // Provenance rows, read through the owner-gated store.
    const refs = [await sourceRefOf('conf:page:100'), await sourceRefOf('conf:page:101')];
    const provenance = await pageStore.forOwnerSources(OWNER, refs);
    const platform = provenance.get(`${refs[0]!.sourceType}:${refs[0]!.sourceId}`);
    expect(platform).toMatchObject({
      kind: 'page',
      pageId: '100',
      title: 'Platform',
      spaceKey: 'ENG',
      spaceName: 'Engineering',
      version: 1,
      url: `${site.baseUrl}/wiki/spaces/ENG/pages/100`,
    });
    const syncEngine = provenance.get(`${refs[1]!.sourceType}:${refs[1]!.sourceId}`);
    expect(syncEngine).toMatchObject({
      pageId: '101',
      parentPageId: '100',
      parentTitle: 'Platform',
    });
  });

  it('unchanged_resync_costs_zero_model_calls_and_zero_body_fetches', async () => {
    const uploadsBefore = files.uploads.length;
    const bodiesBefore = site.bodyFetches;
    await topUpBucket();
    await engine.advance(row.id);

    // The re-list flowed through the ledger on version hashes alone: zero
    // materializations AND zero body fetches, the skip decided before any
    // content existed.
    expect(files.uploads.length).toBe(uploadsBefore);
    expect(site.bodyFetches).toBe(bodiesBefore);
    const runs = await store.recentSyncRuns(row.id);
    expect(runs[0]!.state).toBe('completed');
    expect(runs[0]!.countsJson?.materialized).toBe(0);
    expect(runs[0]!.countsJson?.unchangedSkipped).toBeGreaterThanOrEqual(3);
  });

  it('interrupted_sync_resumes_without_re_extracting', async () => {
    // 14 new pages: more than one pass's page budget at the fake's two
    // results per listing page, so the first advance stops at the pass
    // boundary with the cursor persisted, like a worker crash between
    // passes.
    for (let i = 0; i < 14; i += 1) {
      site.putPage({
        id: String(200 + i),
        spaceKey: 'ENG',
        title: `Bulk Page ${i}`,
        body: `<p>Bulk content ${i}.</p>`,
        modifiedAt: iso(200 - i),
      });
    }
    const uploadsBefore = files.uploads.length;
    await topUpBucket();
    await engine.advance(row.id);
    const afterFirst = files.uploads.length - uploadsBefore;
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(14);

    await settle();
    expect(files.uploads.length - uploadsBefore).toBe(14);
    // Zero duplicates across the interruption.
    const names = files.uploads.slice(uploadsBefore).map((u) => u.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('an_upstream_edit_becomes_a_revision_naming_the_confluence_version', async () => {
    const before = await ledger.byNaturalKey(row.id, 'conf:page:101');
    const newVersion = site.editPage('101', '<p>The sync interval is 5 minutes.</p>');
    expect(newVersion).toBe(2);
    const uploadsBefore = files.uploads.length;
    await settle();

    expect(files.uploads.length).toBe(uploadsBefore + 1);
    const after = await ledger.byNaturalKey(row.id, 'conf:page:101');
    expect(after?.sourceId).not.toBe(before?.sourceId);
    expect(after?.changedAt).not.toBeNull();

    const links = await revisions.forSource(principal, {
      sourceType: 'file',
      sourceId: after!.sourceId!,
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.status).toBe('auto');
    expect(links[0]!.predecessorId).toBe(before?.sourceId);
    const basis = links[0]!.basisJson as { upstreamIdentity?: string; revisionNew?: string };
    expect(basis.upstreamIdentity).toBe('conf:page:101');
    expect(basis.revisionNew).toBe('2');

    // Provenance follows the tip: the new source's row names version 2.
    const ref = await sourceRefOf('conf:page:101');
    const provenance = await pageStore.forOwnerSources(OWNER, [ref]);
    expect(provenance.get(`${ref.sourceType}:${ref.sourceId}`)?.version).toBe(2);
  });

  it('a_restricted_page_is_skipped_and_counted_never_materialized', async () => {
    site.putPage({
      id: '140',
      spaceKey: 'ENG',
      title: 'Secret Plan',
      body: '<p>Need to know only.</p>',
      modifiedAt: iso(5),
    });
    site.restrict('140');
    const uploadsBefore = files.uploads.length;
    await settle();

    expect(files.uploads.length).toBe(uploadsBefore);
    expect(await ledger.byNaturalKey(row.id, 'conf:page:140')).toBeNull();
    const runs = await store.recentSyncRuns(row.id);
    expect(runs[0]!.countsJson?.skippedRestricted).toBeGreaterThanOrEqual(1);
  });

  it('attachments_materialize_only_where_the_scope_opted_in_and_only_supported_types', async () => {
    await store.setSubScopeSelection(row, 'space:ENG', {
      settingsJson: { attachments: true },
    });
    site.putAttachment({
      id: '900',
      pageId: '100',
      title: 'handbook.pdf',
      mediaType: 'application/pdf',
      fileSize: 2048,
      modifiedAt: iso(3),
    });
    site.putAttachment({
      id: '901',
      pageId: '100',
      title: 'demo.mp4',
      mediaType: 'video/mp4',
      modifiedAt: iso(3),
    });
    const uploadsBefore = files.uploads.length;
    const downloadsBefore = site.attachmentDownloads;
    await settle();

    expect(files.uploads.length).toBe(uploadsBefore + 1);
    expect(files.uploads[files.uploads.length - 1]?.name).toBe('handbook.pdf');
    // The unsupported type was never even downloaded.
    expect(site.attachmentDownloads).toBe(downloadsBefore + 1);
    expect(await ledger.byNaturalKey(row.id, 'conf:att:901')).toBeNull();

    const ref = await sourceRefOf('conf:att:900');
    const provenance = await pageStore.forOwnerSources(OWNER, [ref]);
    expect(provenance.get(`${ref.sourceType}:${ref.sourceId}`)).toMatchObject({
      kind: 'attachment',
      pageId: '100',
      attachmentId: '900',
      parentTitle: 'Platform',
    });
  });

  it('a_custom_page_rooted_scope_syncs_the_subtree_only', async () => {
    await store.setSubScopeSelection(row, 'space:ENG', { selected: false });
    await store.addSubScope(row, 'page:100', 'Platform subtree');
    site.putPage({
      id: '110',
      spaceKey: 'ENG',
      title: 'Design Notes',
      parentId: '100',
      body: '<p>Notes under the platform root.</p>',
      modifiedAt: iso(2),
    });
    site.putPage({
      id: '120',
      spaceKey: 'ENG',
      title: 'Offsite Plan',
      body: '<p>Outside the subtree.</p>',
      modifiedAt: iso(1),
    });
    const uploadsBefore = files.uploads.length;
    await settle();

    expect(files.uploads.length).toBe(uploadsBefore + 1);
    expect(files.uploads[files.uploads.length - 1]?.name).toBe(
      'Engineering / Platform / Design Notes.md',
    );
    expect(await ledger.byNaturalKey(row.id, 'conf:page:110')).not.toBeNull();
    expect(await ledger.byNaturalKey(row.id, 'conf:page:120')).toBeNull();
  });

  it('the_presence_sweep_marks_absent_and_archived_and_restores_what_reappears', async () => {
    await store.setSubScopeSelection(row, 'space:ENG', { selected: true });
    site.deletePage('102');
    site.archivePage('200');
    const sweep = new ConnectorPresenceSweep(tdb.db, registry, store, ledger, opener);
    const uploadsBefore = files.uploads.length;

    await sweep.sweep(row.id);
    expect(await ledger.byNaturalKey(row.id, 'conf:page:102')).toMatchObject({
      state: 'deleted_upstream',
      reason: 'absent',
    });
    expect(await ledger.byNaturalKey(row.id, 'conf:page:200')).toMatchObject({
      state: 'deleted_upstream',
      reason: 'archived',
    });
    // The sources remain: deletion is the user's act, never the sweep's.
    expect(files.uploads.length).toBe(uploadsBefore);
    const runs = await store.recentSyncRuns(row.id);
    const presence = runs.find((r) => r.kind === 'presence');
    expect(presence?.state).toBe('completed');
    expect(presence?.countsJson?.presenceMarkedGone).toBe(2);

    site.restorePage('102');
    await sweep.sweep(row.id);
    expect((await ledger.byNaturalKey(row.id, 'conf:page:102'))?.state).toBe('active');
    const latest = (await store.recentSyncRuns(row.id)).find((r) => r.kind === 'presence');
    expect(latest?.countsJson?.presenceRestored).toBe(1);
  });

  it('the_estimate_writes_window_count_and_timestamp_to_the_sub_scope_stats', async () => {
    // The estimate service builds its client on the platform fetch; the
    // fake site stands in for it exactly as it does upstream of the
    // descriptor.
    vi.stubGlobal('fetch', site.handler);
    try {
      const estimator = new ConfluenceEstimateService(store, opener);
      await estimator.estimate(row.id);
    } finally {
      vi.unstubAllGlobals();
    }

    const scopes = await store.subScopes(row.id);
    const subtree = scopes.find((s) => s.key === 'page:100');
    expect(subtree?.statsJson).toMatchObject({ estimatedItems: 3 }); // 100, 101, 110
    expect(subtree?.statsJson?.window).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(subtree?.statsJson?.computedAt).toBeTruthy();
    const space = scopes.find((s) => s.key === 'space:ENG');
    expect(space?.statsJson?.estimatedItems).toBeGreaterThan(3);
  });

  it('removal_destroys_the_credential_and_sync_state_but_provenance_lives_with_its_sources', async () => {
    const uploadsBefore = files.uploads.length;
    const current = (await store.byId(row.id))!;
    await tdb.db.transaction(async (tx) => {
      const destroyed = await credentials.destroy(tx, {
        connectorId: row.id,
        ownerId: OWNER,
        orgId: ORG,
        actor: `user:${OWNER}`,
      });
      expect(destroyed).toBe(1);
      await store.remove(tx, current, `user:${OWNER}`);
    });

    expect(await credentials.describe(row.id)).toBeNull();
    expect(await opener.open(row.id)).toBeNull();
    expect(await store.subScopes(row.id)).toHaveLength(0);
    expect((await store.byId(row.id))?.state).toBe('removed');

    // Sources untouched, and the provenance rows survive with them: they
    // die with their sources through the deletion cascade, not with the
    // connector.
    expect(files.uploads.length).toBe(uploadsBefore);
    const provenanceRows = await tdb.db
      .select()
      .from(confluencePage)
      .where(eq(confluencePage.connectorId, row.id));
    expect(provenanceRows.length).toBeGreaterThan(0);

    // A removed connector never syncs again.
    const searchesBefore = site.searchCalls;
    await engine.advance(row.id);
    expect(site.searchCalls).toBe(searchesBefore);
    expect(files.uploads.length).toBe(uploadsBefore);
  });
});
