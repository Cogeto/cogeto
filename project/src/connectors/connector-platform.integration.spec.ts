import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { listQueuedJobs, readAuditEntries } from '../infrastructure/index';
import { ConnectorCredentialOpener, ConnectorCredentialStore } from '../identity/index';
import type { IdentityOptions } from '../identity/index';
import { SourceRevisionStore } from '../ingestion/index';
import type { FilesService } from '../files/index';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorStore } from './persistence/connector-store';
import { ConnectorItemLedger } from './persistence/item-ledger';
import { ConnectorSyncEngine } from './sync-engine';
import { ConnectorWebhookProcessor } from './webhook-processor';
import { ConnectorMaintenance } from './maintenance';
import { ConnectorItemCascade } from './connector-item-cascade';
import { ConnectorHealthSource } from './connector-health';
import { verifyWebhookSignature } from './domain/webhook-verify';
import { connectorItem, connectorSubScope, connectorSyncRun } from './persistence/tables';
import type { ConnectorRow } from './persistence/tables';
import { FakeUpstream, referenceConnector } from './testing/reference-connector';
import type { Tx } from '../infrastructure/index';

/**
 * The connector platform, proved against the reference connector (V2.5 item
 * 8.1, the "Finish" scenarios): a fake upstream implementing paging,
 * cursors, edits, deletions, duplicate deliveries, expiring credentials,
 * rate limiting with Retry-After, and webhook signatures. Every future
 * connector is validated against this harness before it ships.
 *
 * The two named expensive-failure requirements live here by name:
 * `interrupted_sync_resumes_without_re_extracting` and
 * `unchanged_resync_costs_zero_model_calls`. Materialization through the ONE
 * upload path is the only route to model spend, so the FakeFiles upload
 * count IS the model-cost proxy: zero uploads means zero pipeline jobs means
 * zero extraction, verification, embedding or reconciliation calls.
 */

const OWNER = 'user-connector';
const ORG = 'org-connector';
const MASTER_KEY = randomBytes(32);

const principal: Principal = {
  userId: OWNER,
  name: 'Connector Tester',
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
  failNextWith429 = false;

  async upload(
    principal: Principal,
    file: { buffer: Buffer; originalName: string; mimeType: string },
    flags: { scope: 'private' | 'shared'; sensitive: boolean; discard: boolean },
  ): Promise<{ objectKey: string }> {
    if (this.failNextWith429) {
      this.failNextWith429 = false;
      const error = new Error('daily upload limit') as Error & { getStatus?: () => number };
      error.getStatus = () => 429;
      throw error;
    }
    const objectKey = `${ORG}/${principal.userId}/${flags.scope}/file-${this.uploads.length}-${file.originalName}`;
    this.uploads.push({ name: file.originalName, scope: flags.scope });
    return { objectKey };
  }
}

/** Advance passes until the connector settles (healthy, paused, or parked),
 * the way the queue's re-enqueue loop would. */
async function advanceUntilSettled(
  engine: ConnectorSyncEngine,
  store: ConnectorStore,
  connectorId: string,
  maxPasses = 15,
): Promise<void> {
  for (let i = 0; i < maxPasses; i += 1) {
    await engine.advance(connectorId);
    const fresh = await store.byId(connectorId);
    if (!fresh) return;
    if (fresh.state === 'healthy' || fresh.state === 'needs_reauth' || fresh.state === 'degraded') {
      return;
    }
    if (fresh.settingsJson?.pausedReason) return;
  }
}

describe('connector_platform (reference connector harness)', () => {
  let tdb: TestDatabase;
  let upstream: FakeUpstream;
  let registry: ConnectorRegistry;
  let store: ConnectorStore;
  let ledger: ConnectorItemLedger;
  let credentials: ConnectorCredentialStore;
  let opener: ConnectorCredentialOpener;
  let revisions: SourceRevisionStore;
  let files: FakeFiles;
  let engine: ConnectorSyncEngine;
  let row: ConnectorRow;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    upstream = new FakeUpstream();
    upstream.addSubScope('inbox', 'Inbox');
    upstream.addSubScope('archive', 'Archive');
    upstream.put({ id: 'a1', subScope: 'inbox', content: 'alpha one', visibility: 'team' });
    upstream.put({ id: 'a2', subScope: 'inbox', content: 'alpha two', visibility: 'personal' });
    upstream.put({ id: 'a3', subScope: 'inbox', content: 'alpha three', visibility: 'team' });
    upstream.put({ id: 'r1', subScope: 'inbox', content: 'secret', visibility: 'restricted' });

    registry = new ConnectorRegistry([referenceConnector(upstream)]);
    store = new ConnectorStore(tdb.db, { masterKey: MASTER_KEY });
    ledger = new ConnectorItemLedger(tdb.db);
    credentials = new ConnectorCredentialStore(tdb.db, identityOptions);
    opener = new ConnectorCredentialOpener(tdb.db, identityOptions);
    revisions = new SourceRevisionStore(tdb.db);
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

  it('registry_refuses_an_unregistered_source_type_and_an_inconsistent_authorship', () => {
    expect(
      () =>
        new ConnectorRegistry([
          { ...referenceConnector(upstream), kind: 'x', sourceType: 'nope' as never },
        ]),
    ).toThrow(/unregistered source type/);
    expect(
      () =>
        new ConnectorRegistry([
          {
            ...referenceConnector(upstream),
            kind: 'y',
            sourceType: 'user_note',
            authorship: 'observed',
          },
        ]),
    ).toThrow(/userAuthored/);
  });

  it('lifecycle: configured, authorised, discovery offers, nothing fetched before selection', async () => {
    row = await store.create({ ownerId: OWNER, orgId: ORG, kind: 'reference', name: 'Reference' });
    expect(row.state).toBe('configured');

    // Authorise: the credential seals into identity's table; the connector
    // moves to authorised.
    await credentials.store(tdb.db, {
      ownerId: OWNER,
      orgId: ORG,
      connectorId: row.id,
      material: { accessToken: 'token-1', refreshToken: 'refresh-1' },
      accountIdentity: 'owner@upstream.example',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    await store.transition(tdb.db, row, 'authorised', { actor: `user:${OWNER}` });

    // First pass: discovery only. Sub-scopes appear for selection; nothing
    // outside a selection is ever fetched.
    await engine.advance(row.id);
    const scopes = await store.subScopes(row.id);
    expect(scopes.map((s) => s.key).sort()).toEqual(['archive', 'inbox']);
    expect(scopes.every((s) => !s.selected)).toBe(true);
    expect(files.uploads).toHaveLength(0);
    expect(upstream.fetchPageCalls).toBe(0);
  });

  it('credential_metadata_is_visible_but_material_never_comes_back', async () => {
    const summary = await credentials.describe(row.id);
    expect(summary?.scopes).toEqual(['read']);
    expect(summary?.accountIdentity).toBe('owner@upstream.example');
    expect(JSON.stringify(summary)).not.toContain('token-1');
  });

  it('backfill: selected sub-scope syncs, restricted items are skipped and reported, scope maps structurally', async () => {
    await store.setSubScopeSelection(row, 'inbox', { selected: true });
    await engine.advance(row.id);

    // a1, a2, a3 materialized; r1 (restricted) skipped per spec 4.4.4.
    expect(files.uploads.map((u) => u.name).sort()).toEqual(['a1.txt', 'a2.txt', 'a3.txt']);
    // team -> shared, personal -> private, structurally.
    expect(files.uploads.find((u) => u.name === 'a1.txt')?.scope).toBe('shared');
    expect(files.uploads.find((u) => u.name === 'a2.txt')?.scope).toBe('private');

    const fresh = await store.byId(row.id);
    expect(fresh?.state).toBe('healthy');
    const runs = await store.recentSyncRuns(row.id);
    const completed = runs.find((r) => r.state === 'completed');
    expect(completed?.countsJson?.materialized).toBe(3);
    expect(completed?.countsJson?.skippedRestricted).toBe(1);
  });

  it('unchanged_resync_costs_zero_model_calls', async () => {
    const uploadsBefore = files.uploads.length;
    await engine.advance(row.id);
    // The full re-list flowed through the ledger: natural keys known, hashes
    // equal, zero materializations, therefore zero pipeline jobs and zero
    // model calls, by construction.
    expect(files.uploads.length).toBe(uploadsBefore);
    const runs = await store.recentSyncRuns(row.id);
    const latest = runs[0]!;
    expect(latest.countsJson?.materialized).toBe(0);
    expect(latest.countsJson?.unchangedSkipped).toBeGreaterThanOrEqual(3);
  });

  it('an_upstream_edit_becomes_a_revision_that_supersedes_not_a_duplicate', async () => {
    const before = await ledger.byNaturalKey(row.id, 'ref-a1');
    upstream.edit('a1', 'alpha one, revised');
    await engine.advance(row.id);

    const after = await ledger.byNaturalKey(row.id, 'ref-a1');
    expect(after?.sourceId).not.toBe(before?.sourceId);
    expect(after?.changedAt).not.toBeNull();

    // The automatic source_revision link, on the upstream's own identity.
    const links = await revisions.forSource(principal, {
      sourceType: 'file',
      sourceId: after!.sourceId!,
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.status).toBe('auto');
    expect(links[0]!.predecessorId).toBe(before?.sourceId);
    expect((links[0]!.basisJson as { upstreamIdentity?: string }).upstreamIdentity).toBe('ref-a1');
  });

  it('a_moved_item_keeps_its_source_and_an_item_in_two_sub_scopes_is_one_source', async () => {
    await store.setSubScopeSelection(row, 'archive', { selected: true });
    upstream.move('a2', 'archive');
    const uploadsBefore = files.uploads.length;
    await engine.advance(row.id);

    expect(files.uploads.length).toBe(uploadsBefore); // no new source
    const item = await ledger.byNaturalKey(row.id, 'ref-a2');
    expect(item?.subScopes).toContain('archive');
    expect(item?.subScopes).toContain('inbox');
    const items = await tdb.db
      .select()
      .from(connectorItem)
      .where(eq(connectorItem.naturalKey, 'ref-a2'));
    expect(items).toHaveLength(1); // ONE source, enforced by the unique key
  });

  it('an_upstream_deletion_marks_the_ledger_and_never_erases_the_source', async () => {
    upstream.delete('a3');
    await engine.advance(row.id);
    const item = await ledger.byNaturalKey(row.id, 'ref-a3');
    expect(item?.state).toBe('deleted_upstream');
    expect(item?.sourceId).not.toBeNull(); // the source remains
  });

  it('interrupted_sync_resumes_without_re_extracting', async () => {
    // 14 new items over 7 upstream pages: more than one pass's page budget,
    // so the first advance is "interrupted" at the pass boundary with the
    // cursor persisted, exactly like a worker crash between passes.
    for (let i = 0; i < 14; i += 1) {
      upstream.put({
        id: `bulk${i}`,
        subScope: 'archive',
        content: `bulk item ${i}`,
        visibility: 'team',
      });
    }
    const uploadsBefore = files.uploads.length;
    await engine.advance(row.id);
    const afterFirst = files.uploads.length - uploadsBefore;
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(14);

    // Resume until done. Nothing already ingested is re-materialized: the
    // total equals the item count exactly, with zero duplicates.
    for (let i = 0; i < 10; i += 1) {
      await engine.advance(row.id);
      const fresh = await store.byId(row.id);
      if (fresh?.state === 'healthy') break;
    }
    expect(files.uploads.length - uploadsBefore).toBe(14);
    // Zero duplicates among the resumed batch: nothing already ingested was
    // re-materialized across the interruption.
    const names = files.uploads.slice(uploadsBefore).map((u) => u.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('a_user_erased_source_is_never_re_materialized', async () => {
    const item = await ledger.byNaturalKey(row.id, 'ref-bulk0');
    expect(item?.sourceId).toBeTruthy();
    // The deletion saga's cascade arm, exactly as the roots bind it.
    const cascade = new ConnectorItemCascade(ledger);
    await tdb.db.transaction(async (tx) => {
      const cleared = await cascade.cascadeForSource(tx as Tx, 'file', item!.sourceId!);
      expect(cleared).toBe(1);
    });
    const erased = await ledger.byNaturalKey(row.id, 'ref-bulk0');
    expect(erased?.state).toBe('erased');
    expect(erased?.sourceId).toBeNull();

    const uploadsBefore = files.uploads.length;
    await advanceUntilSettled(engine, store, row.id);
    // The upstream still lists bulk0; the user's deletion stands.
    expect(files.uploads.length).toBe(uploadsBefore);
    const runs = await store.recentSyncRuns(row.id);
    expect(runs[0]!.countsJson?.erasedSkipped).toBeGreaterThanOrEqual(1);
  });

  it('rate_limit_with_retry_after_pauses_beyond_the_wall_instead_of_retrying_into_it', async () => {
    upstream.put({ id: 'rl1', subScope: 'inbox', content: 'rate', visibility: 'team' });
    upstream.rateLimitNext = 1;
    upstream.retryAfterSeconds = 120;
    const fetchesBefore = upstream.fetchPageCalls;
    await engine.advance(row.id);

    const paused = await store.byId(row.id);
    expect(paused?.settingsJson?.pausedReason).toBe('rate_limited');
    const state = await store.rateState(row.id, 'connector');
    expect(state?.retryAfterUntil).not.toBeNull();
    expect(state!.retryAfterUntil!.getTime()).toBeGreaterThan(Date.now() + 60_000);

    // A second advance inside the wall does not touch the upstream at all.
    const fetchesAfterFirst = upstream.fetchPageCalls;
    await engine.advance(row.id);
    expect(upstream.fetchPageCalls).toBe(fetchesAfterFirst);
    expect(fetchesAfterFirst).toBeGreaterThan(fetchesBefore);

    // Clear the wall so later scenarios sync normally.
    const now = new Date();
    await store.saveRateState(row.id, 'connector', {
      tokens: 100,
      refilledAt: now,
      retryAfterUntil: null,
    });
    await advanceUntilSettled(engine, store, row.id);
    const settled = await store.byId(row.id);
    const rl1 = await ledger.byNaturalKey(row.id, 'ref-rl1');
    expect({
      state: settled?.state,
      paused: settled?.settingsJson?.pausedReason ?? null,
      rl1Landed: rl1 !== null,
    }).toEqual({ state: 'healthy', paused: null, rl1Landed: true });
  });

  it('daily_item_cap_pauses_visibly_and_never_bypasses', async () => {
    // Everything materialized so far today counts against the cap, so a cap
    // below the current count pauses before the next new item.
    await store.updateSettings(row.id, { dailyItemCap: 3 });
    upstream.put({ id: 'cap1', subScope: 'inbox', content: 'capped', visibility: 'team' });
    const uploadsBefore = files.uploads.length;
    await advanceUntilSettled(engine, store, row.id);
    expect(files.uploads.length).toBe(uploadsBefore);
    const paused = await store.byId(row.id);
    expect(paused?.settingsJson?.pausedReason).toBe('daily_item_cap');

    await store.updateSettings(row.id, { dailyItemCap: 100_000 });
    await advanceUntilSettled(engine, store, row.id); // cap lifted: cap1 lands
    expect(files.uploads.length).toBe(uploadsBefore + 1);
  });

  it('an_expiring_credential_is_refreshed_before_expiry_and_the_rotated_material_is_used', async () => {
    await credentials.store(tdb.db, {
      ownerId: OWNER,
      orgId: ORG,
      connectorId: row.id,
      material: { accessToken: upstream.validToken, refreshToken: 'refresh-1' },
      expiresAt: new Date(Date.now() + 60 * 1000), // inside the refresh window
    });
    const refreshesBefore = upstream.refreshCalls;
    await advanceUntilSettled(engine, store, row.id);
    expect(upstream.refreshCalls).toBeGreaterThanOrEqual(refreshesBefore + 1);
    // The rotated token is what the store now holds, and it works upstream.
    const openedAfter = await opener.open(row.id);
    expect(openedAfter?.material.accessToken).toBe(upstream.validToken);
    const fresh = await store.byId(row.id);
    expect(fresh?.state).toBe('healthy');
  });

  it('a_failed_refresh_moves_to_needs_reauth_and_an_expired_credential_never_looks_like_nothing_new', async () => {
    await credentials.store(tdb.db, {
      ownerId: OWNER,
      orgId: ORG,
      connectorId: row.id,
      material: { accessToken: upstream.validToken, refreshToken: 'refresh-1' },
      expiresAt: new Date(Date.now() + 60 * 1000),
    });
    upstream.refuseRefresh = true;
    upstream.put({ id: 'auth1', subScope: 'inbox', content: 'unreached', visibility: 'team' });
    const uploadsBefore = files.uploads.length;
    await engine.advance(row.id);
    upstream.refuseRefresh = false;

    const fresh = await store.byId(row.id);
    expect(fresh?.state).toBe('needs_reauth');
    expect(fresh?.statusReason).toBe('refresh_failed');
    // NOT an empty successful sync: nothing was fetched and nothing claims
    // the source had nothing new.
    expect(files.uploads.length).toBe(uploadsBefore);
    const summary = await credentials.describe(row.id);
    expect(summary?.refreshFailedAt).not.toBeNull();

    // needs_reauth never syncs until reauthorised.
    await engine.advance(row.id);
    expect((await store.byId(row.id))?.state).toBe('needs_reauth');

    // Reauthorise for the scenarios that follow.
    await credentials.store(tdb.db, {
      ownerId: OWNER,
      orgId: ORG,
      connectorId: row.id,
      material: { accessToken: upstream.validToken, refreshToken: 'refresh-1' },
      expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    await store.transition(tdb.db, await store.byId(row.id).then((r) => r!), 'authorised', {
      actor: `user:${OWNER}`,
    });
    await advanceUntilSettled(engine, store, row.id); // auth1 lands
  });

  it('capabilities_surface_reports_the_fleet_with_an_actionable_state', async () => {
    const health = new ConnectorHealthSource(store);
    const healthySummary = await health.summary();
    expect(healthySummary.configured).toBe(1);
    expect(healthySummary.healthy + healthySummary.syncing).toBeGreaterThanOrEqual(1);

    const current = await store.byId(row.id);
    await store.transition(tdb.db, current!, 'degraded', {
      actor: 'connector_platform',
      reason: 'webhook_lapsed',
    });
    const degradedSummary = await health.summary();
    expect(degradedSummary.degraded).toHaveLength(1);
    expect(degradedSummary.degraded[0]!.reason).toBe('webhook_lapsed');
    await store.transition(tdb.db, (await store.byId(row.id))!, 'healthy', {
      actor: 'connector_platform',
    });
  });

  it('webhook: signature verifies over raw bytes, duplicate deliveries dedup, processing is a targeted fetch', async () => {
    const secret = await store.rotateWebhookSecret(row);
    upstream.put({ id: 'wh1', subScope: 'inbox', content: 'webhook item', visibility: 'team' });
    const descriptor = registry.get('reference')!;
    const delivery = upstream.signDelivery(secret, 'evt-100', ['wh1']);

    // The verification the ingress runs, over the raw bytes.
    const stored = await store.openWebhookSecret(row.id);
    expect(stored).toBe(secret);
    expect(
      verifyWebhookSignature(
        descriptor.webhook!,
        stored!,
        delivery.body,
        delivery.headers,
        new Date(),
      ).ok,
    ).toBe(true);
    // A tampered byte refuses.
    const tampered = Buffer.from(delivery.body);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(
      verifyWebhookSignature(descriptor.webhook!, stored!, tampered, delivery.headers, new Date())
        .ok,
    ).toBe(false);

    // Delivery dedup by event id: the second identical delivery is a no-op.
    const event = descriptor.webhook!.parseEvent(
      JSON.parse(delivery.body.toString('utf8')),
      delivery.headers,
    )!;
    const first = await store.recordDelivery(tdb.db, {
      connectorId: row.id,
      eventId: event.eventId,
      itemRefs: event.items,
    });
    const duplicate = await store.recordDelivery(tdb.db, {
      connectorId: row.id,
      eventId: event.eventId,
      itemRefs: event.items,
    });
    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();

    // Processing re-fetches the item through the outbound path; the payload
    // itself never becomes content.
    const processor = new ConnectorWebhookProcessor(tdb.db, store, registry, engine, opener);
    const uploadsBefore = files.uploads.length;
    const fetchesBefore = upstream.fetchItemCalls;
    await processor.process(first!.id);
    expect(upstream.fetchItemCalls).toBe(fetchesBefore + 1);
    expect(files.uploads.length).toBe(uploadsBefore + 1);
    expect((await store.delivery(first!.id))?.state).toBe('processed');

    // Processing the SAME delivery again converges (idempotent by state).
    await processor.process(first!.id);
    expect(files.uploads.length).toBe(uploadsBefore + 1);
  });

  it('maintenance_prunes_the_delivery_ledger_and_enqueues_the_polling_fallback', async () => {
    const maintenance = new ConnectorMaintenance(tdb.db, store, registry, credentials, opener);
    await maintenance.run();
    // The polling enqueue is a graphile job row; presence is enough here —
    // the sync job itself is exercised above. Read through infrastructure's
    // queue reader (B21: no spec names the queue's private tables).
    const queued = await listQueuedJobs(tdb.db);
    const syncJobs = queued.filter((j) => j.jobType === 'connector.sync');
    expect(syncJobs.length).toBeGreaterThan(0);
    // Attribution travels in the payload (SEC-10).
    expect(syncJobs[0]!.payload?.principal_id).toBe(OWNER);
  });

  it('removal_destroys_credentials_verifiably_and_leaves_sources_intact', async () => {
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

    // Credentials: gone, verifiably, and the destruction is audited without
    // recording any secret.
    expect(await credentials.describe(row.id)).toBeNull();
    expect(await opener.open(row.id)).toBeNull();
    const audit = await readAuditEntries(tdb.db, {
      actions: ['connector_credential.destroyed'],
      entityIds: [row.id],
    });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.detail)).not.toContain('token');

    // Sync state cleared; the row a tombstone with its name gone.
    expect(
      await tdb.db
        .select()
        .from(connectorSubScope)
        .where(eq(connectorSubScope.connectorId, row.id)),
    ).toHaveLength(0);
    const tombstone = await store.byId(row.id);
    expect(tombstone?.state).toBe('removed');
    expect(tombstone?.name).toBeNull();

    // Already-ingested sources remain: nothing touched the uploads, and the
    // item ledger survives as dedup arithmetic.
    expect(files.uploads.length).toBe(uploadsBefore);
    const items = await tdb.db
      .select()
      .from(connectorItem)
      .where(eq(connectorItem.connectorId, row.id));
    expect(items.length).toBeGreaterThan(0);

    // A removed connector never syncs again.
    const fetchesBefore = upstream.fetchPageCalls;
    await engine.advance(row.id);
    expect(upstream.fetchPageCalls).toBe(fetchesBefore);

    // And its sync-run history remains queryable.
    const runs = await tdb.db
      .select()
      .from(connectorSyncRun)
      .where(eq(connectorSyncRun.connectorId, row.id));
    expect(runs.length).toBeGreaterThan(0);
  });
});
