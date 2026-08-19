import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { ConnectorCredentialOpener, ConnectorCredentialStore } from '../identity/index';
import type { IdentityOptions } from '../identity/index';
import { SourceRevisionStore } from '../ingestion/index';
import type { FilesService } from '../files/index';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorStore } from './persistence/connector-store';
import { ConnectorItemLedger } from './persistence/item-ledger';
import { ConnectorSyncEngine } from './sync-engine';
import { ConnectorSpaceCleanup } from './connector-space-cleanup';
import { connectorItem, connectorSubScope } from './persistence/tables';
import type { ConnectorRow } from './persistence/tables';
import { FakeUpstream, referenceConnector } from './testing/reference-connector';

/**
 * Connectors belong to a space (docs/features/spaces.md section 6c, issue
 * B): the same upstream connected into two spaces is two entirely
 * independent connectors. Independent cursors and sub-scope selections,
 * disjoint natural-key ledgers with no shared deduplication, every
 * materialized source stamped with the connector's own space, machine
 * revision links sealed per space, cross-space invisibility on every
 * owner-facing read, and the space-deletion leg removing one space's
 * connector (credential, ledger and cascades included) while the other's
 * keeps syncing.
 */

const OWNER = 'user-two-spaces';
const ORG = 'org-two-spaces';
const MASTER_KEY = randomBytes(32);
const SPACE_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SPACE_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

const identityOptions: IdentityOptions = {
  internalBaseUrl: 'http://zitadel.invalid',
  externalDomain: 'localhost',
  cacheTtlSeconds: 1,
  masterKey: MASTER_KEY,
  credentialReads: true,
};

function principalIn(spaceId: string): Principal {
  return { userId: OWNER, name: '', email: null, orgId: ORG, orgName: '', roles: [], spaceId };
}

/** The upload seam, recording WHICH SPACE each materialization landed in
 * (the sync engine's fabricated principal carries the connector row's). */
class SpaceRecordingFiles {
  uploads: { name: string; spaceId: string | undefined }[] = [];

  async upload(
    principal: Principal,
    file: { buffer: Buffer; originalName: string; mimeType: string },
    flags: { scope: 'private' | 'shared'; sensitive: boolean; discard: boolean },
  ): Promise<{ objectKey: string }> {
    const objectKey = `${ORG}/${principal.userId}/${flags.scope}/file-${this.uploads.length}-${file.originalName}`;
    this.uploads.push({ name: file.originalName, spaceId: principal.spaceId });
    return { objectKey };
  }
}

describe('connectors belong to a space (integration: real Postgres)', () => {
  let tdb: TestDatabase;
  let upstream: FakeUpstream;
  let store: ConnectorStore;
  let ledger: ConnectorItemLedger;
  let credentials: ConnectorCredentialStore;
  let revisions: SourceRevisionStore;
  let files: SpaceRecordingFiles;
  let engine: ConnectorSyncEngine;
  let rowA: ConnectorRow;
  let rowB: ConnectorRow;

  // The fake upstream accepts one valid token: connecting the same site
  // into two spaces is the same authorisation made twice, which is the
  // decision record's point (credentials instance-level, use space-bound).
  const activate = async (row: ConnectorRow): Promise<void> => {
    await credentials.store(tdb.db, {
      ownerId: OWNER,
      orgId: ORG,
      connectorId: row.id,
      material: { accessToken: 'token-1', refreshToken: 'refresh-1' },
      accountIdentity: 'owner@upstream.example',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
      spaceId: row.spaceId,
    });
    await store.transition(tdb.db, row, 'authorised', { actor: `user:${OWNER}` });
    await engine.advance(row.id); // discovery
    const fresh = (await store.byId(row.id))!;
    await store.setSubScopeSelection(fresh, 'inbox', { selected: true });
    await engine.advance(row.id); // backfill
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    for (const [id, name] of [
      [SPACE_A, 'Space A'],
      [SPACE_B, 'Space B'],
    ]) {
      await tdb.pool.query(`INSERT INTO space (id, name) VALUES ($1, $2)`, [id, name]);
    }
    upstream = new FakeUpstream();
    upstream.addSubScope('inbox', 'Inbox');
    upstream.put({ id: 'a1', subScope: 'inbox', content: 'alpha one', visibility: 'team' });
    upstream.put({ id: 'a2', subScope: 'inbox', content: 'alpha two', visibility: 'team' });

    const registry = new ConnectorRegistry([referenceConnector(upstream)]);
    store = new ConnectorStore(tdb.db, { masterKey: MASTER_KEY });
    ledger = new ConnectorItemLedger(tdb.db);
    credentials = new ConnectorCredentialStore(tdb.db, identityOptions);
    revisions = new SourceRevisionStore(tdb.db);
    files = new SpaceRecordingFiles();
    engine = new ConnectorSyncEngine(
      tdb.db,
      registry,
      store,
      ledger,
      credentials,
      revisions,
      new ConnectorCredentialOpener(tdb.db, identityOptions),
      files as unknown as FilesService,
    );
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  it('the_same_upstream_in_two_spaces_is_two_independent_connectors: disjoint ledgers, no shared deduplication', async () => {
    rowA = await store.create({
      ownerId: OWNER,
      orgId: ORG,
      kind: 'reference',
      name: 'Ref in A',
      spaceId: SPACE_A,
    });
    rowB = await store.create({
      ownerId: OWNER,
      orgId: ORG,
      kind: 'reference',
      name: 'Ref in B',
      spaceId: SPACE_B,
    });
    await activate(rowA);
    await activate(rowB);

    // BOTH connectors materialized the same upstream items: the ledger's
    // (connector_id, natural_key) key partitions by connector, so the second
    // space's sync is a first sync, never a dedup hit against the first's.
    expect(files.uploads.filter((u) => u.spaceId === SPACE_A).map((u) => u.name)).toEqual([
      'a1.txt',
      'a2.txt',
    ]);
    expect(files.uploads.filter((u) => u.spaceId === SPACE_B).map((u) => u.name)).toEqual([
      'a1.txt',
      'a2.txt',
    ]);
    const itemA = await ledger.byNaturalKey(rowA.id, 'ref-a1');
    const itemB = await ledger.byNaturalKey(rowB.id, 'ref-a1');
    expect(itemA?.sourceId).toBeTruthy();
    expect(itemB?.sourceId).toBeTruthy();
    expect(itemA!.sourceId).not.toBe(itemB!.sourceId);
  });

  it('cursors_and_sync_state_are_per_connector: an edit advances each space independently', async () => {
    upstream.edit('a1', 'alpha one, revised');
    // Only A syncs: A sees the change, B's ledger still holds the old hash.
    const before = files.uploads.length;
    await engine.advance(rowA.id);
    expect(files.uploads.length).toBe(before + 1);
    expect(files.uploads.at(-1)).toMatchObject({ name: 'a1.txt', spaceId: SPACE_A });
    const staleB = await ledger.byNaturalKey(rowB.id, 'ref-a1');
    expect(staleB?.changedAt).toBeNull();
    // B catches up on ITS next sync, materializing its own copy in ITS space.
    await engine.advance(rowB.id);
    expect(files.uploads.at(-1)).toMatchObject({ name: 'a1.txt', spaceId: SPACE_B });
  });

  it('machine_revision_links_are_sealed_per_space: each connector recorded its own, invisible across', async () => {
    const itemA = (await ledger.byNaturalKey(rowA.id, 'ref-a1'))!;
    const itemB = (await ledger.byNaturalKey(rowB.id, 'ref-a1'))!;
    const linksA = await revisions.forSource(principalIn(SPACE_A), {
      sourceType: 'file',
      sourceId: itemA.sourceId!,
    });
    expect(linksA).toHaveLength(1);
    // The other space's principal sees nothing for the SAME ref.
    expect(
      await revisions.forSource(principalIn(SPACE_B), {
        sourceType: 'file',
        sourceId: itemA.sourceId!,
      }),
    ).toHaveLength(0);
    expect(
      await revisions.forSource(principalIn(SPACE_B), {
        sourceType: 'file',
        sourceId: itemB.sourceId!,
      }),
    ).toHaveLength(1);
  });

  it('a_connector_is_invisible_from_another_space: by-id reads as not found, listings stay sealed', async () => {
    await expect(store.byIdForOwner(rowA.id, OWNER, SPACE_B)).rejects.toThrow(/no such connector/);
    expect((await store.listForOwner(OWNER, SPACE_A)).map((r) => r.id)).toEqual([rowA.id]);
    expect((await store.listForOwner(OWNER, SPACE_B)).map((r) => r.id)).toEqual([rowB.id]);
  });

  it('the_upstream_state_read_is_sealed_by_the_connector_join: a foreign ref surfaces nothing', async () => {
    const itemA = (await ledger.byNaturalKey(rowA.id, 'ref-a1'))!;
    const sealed = await ledger.upstreamStateForSources(OWNER, SPACE_B, [
      { sourceType: 'file', sourceId: itemA.sourceId! },
    ]);
    expect(sealed.size).toBe(0);
    const own = await ledger.upstreamStateForSources(OWNER, SPACE_A, [
      { sourceType: 'file', sourceId: itemA.sourceId! },
    ]);
    expect(own.size).toBe(1);
  });

  it('the_space_deletion_leg_removes_one_space_connector_whole_and_leaves_the_other_syncing', async () => {
    const cleanup = new ConnectorSpaceCleanup(tdb.db, credentials);
    expect(await cleanup.countForSpace(SPACE_B)).toBe(1);
    const { count } = await cleanup.cleanupSpace(SPACE_B);
    expect(count).toBe(1);

    // Row, ledger, credential and cascades gone for B; A untouched.
    expect(await store.byId(rowB.id)).toBeNull();
    expect(
      await tdb.db.select().from(connectorItem).where(eq(connectorItem.connectorId, rowB.id)),
    ).toHaveLength(0);
    expect(
      await tdb.db
        .select()
        .from(connectorSubScope)
        .where(eq(connectorSubScope.connectorId, rowB.id)),
    ).toHaveLength(0);
    expect(await credentials.describe(rowB.id)).toBeNull();
    expect(await credentials.describe(rowA.id)).not.toBeNull();

    // The other space's connector keeps syncing (unchanged = zero uploads).
    const before = files.uploads.length;
    await engine.advance(rowA.id);
    expect(files.uploads.length).toBe(before);
    expect((await store.byId(rowA.id))?.state).toBe('healthy');
  });
});
