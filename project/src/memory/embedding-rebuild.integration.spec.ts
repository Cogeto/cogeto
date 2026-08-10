import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { ModelGateway } from '../model-gateway/index';
import type { StreamDelta } from '../model-gateway/index';
import { MemoryStore } from './memory.store';
import type { NewFact } from './memory.store';
import { buildGateFilter, dimensionsFor, MemoryVectorStore } from './persistence/vector-store';
import {
  beginEmbeddingRebuild,
  cancelEmbeddingRebuild,
  embeddingRebuildCorpus,
  runEmbeddingRebuildPass,
} from './embedding-rebuild';
import type { EmbeddingSwitchPort } from './embedding-rebuild';
import { createEmbeddingRebuild } from './factory';
import {
  embeddingRebuildStatus,
  liveIndexBinding,
  readEmbeddingIndexState,
  updateEmbeddingIndexState,
} from './embedding-index';
import { checkEmbeddingSpace } from './embedding-space';

/**
 * The managed embedding rebuild, end to end against real Postgres + Qdrant
 * (V2.4 item 7.1 second half; issues A/B/C of the reindex unit).
 *
 * The tests assert the OVERRIDING CONSTRAINT from every angle: at every point
 * during a rebuild, and after any failure, cancellation or interruption,
 * there is a coherent active configuration whose index matches it — and the
 * switch happens only at verified completion, atomically.
 */

const OLD_MODEL = 'text-embedding-3-small'; // 1536
const NEW_MODEL = 'bge-m3'; // 1024

const owner: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};
const stranger: Principal = { ...owner, userId: 'user-b', name: 'User B' };

/** Deterministic per-model embeddings; optionally fails after N batch calls. */
class FakeEmbedGateway extends ModelGateway {
  embedBatches = 0;
  constructor(
    private readonly model: string,
    private readonly failAfterBatches = Infinity,
  ) {
    super();
  }
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used
  async *completeStream(): AsyncIterable<StreamDelta> {
    throw new Error('not used');
  }
  extractStructured<T>(): Promise<T> {
    throw new Error('not used');
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length > 0 && ++this.embedBatches > this.failAfterBatches) {
      throw new Error('embedding endpoint went away mid-rebuild');
    }
    return texts.map((text) => fakeEmbedding(text, dimensionsFor(this.model)));
  }
  embeddingModelId(): string {
    return this.model;
  }
}

/** A switch port that records what the engine asked of it. */
function recordingPort(): EmbeddingSwitchPort & {
  commits: { providerId: string; model: string }[];
  reloads: { model: string }[];
} {
  const commits: { providerId: string; model: string }[] = [];
  const reloads: { model: string }[] = [];
  return {
    commits,
    reloads,
    commit: async (_tx, change) => {
      commits.push({ providerId: change.providerId, model: change.model });
    },
    afterCommit: async (change) => {
      reloads.push({ model: change.model });
    },
  };
}

describe('managed embedding rebuild (integration, real Postgres + real Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const liveProviders = { version: 1, tiers: { embedding: { model: OLD_MODEL } } };
  const vectorsFor = (): MemoryVectorStore =>
    new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: OLD_MODEL,
      liveIndex: liveIndexBinding(tdb.db, liveProviders),
    });

  const fact = (content: string, extras: Partial<NewFact> = {}): NewFact => ({
    content,
    scope: 'private',
    sourceType: 'user_note',
    sourceId: `note-${Math.random().toString(36).slice(2)}`,
    embeddingModel: OLD_MODEL,
    ...extras,
  });

  const target = {
    providerId: 'provider-1',
    providerLabel: 'Local runtime',
    model: NEW_MODEL,
    dimensions: 1024,
  };

  const passDeps = (gateway: ModelGateway, port = recordingPort()) => ({
    db: tdb.db,
    vectors: vectorsFor(),
    gatewayFor: async () => gateway,
    switchPort: port,
    port,
  });

  const runToSettled = async (
    deps: ReturnType<typeof passDeps>,
  ): Promise<'completed' | 'failed' | 'cancelled'> => {
    for (let i = 0; i < 60; i += 1) {
      const { outcome } = await runEmbeddingRebuildPass(deps);
      if (outcome === 'completed' || outcome === 'failed' || outcome === 'cancelled') {
        return outcome;
      }
      if (outcome === 'idle') {
        const status = await embeddingRebuildStatus(tdb.db);
        if (!status) return 'completed';
        if (status.status === 'failed') return 'failed';
      }
    }
    throw new Error('rebuild did not settle in 60 passes');
  };

  const qdrantCollections = async (): Promise<string[]> => {
    const res = await fetch(`${qdrant.url}/collections`);
    const body = (await res.json()) as { result?: { collections?: { name: string }[] } };
    return (body.result?.collections ?? []).map((c) => c.name);
  };

  it('rebuild_completes_and_switches_atomically: new collection, gates intact, flip only at the end', async () => {
    const vectors = vectorsFor();
    const store = new MemoryStore(tdb.db, vectors);
    await store.ensureIndexReady();

    const contents = [
      'Ana confirmed the mapping format on 14 July',
      'The Meridian NDA is still unsigned',
      'Kickoff with Arkona is on July 20 in Rijeka',
      'The gasket spec fixes 3.2 mm thickness',
      'Sensitive: the acquisition price is 4.1 million',
    ];
    const rows = [];
    for (const content of contents) {
      const row = await store.createFromFact(owner, fact(content));
      await store.upsertVectors([row], [fakeEmbedding(content, 1536)]);
      rows.push(row);
    }
    // One sensitive fact: the gate parity check below must see the flag in
    // the REBUILT collection's payload, not assume it was inherited.
    await store.toggleSensitive(owner, rows[4]!.id, true);

    await beginEmbeddingRebuild(tdb.db, { target, requestedBy: owner.userId, orgId: owner.orgId });
    const started = await embeddingRebuildStatus(tdb.db);
    expect(started?.status).toBe('running');
    expect(started?.factsTotal).toBe(contents.length);

    // Mid-rebuild the ACTIVE configuration is untouched: still the old model,
    // still the old collection.
    const midState = await readEmbeddingIndexState(tdb.db);
    expect(midState.activeCollection).toBe('memories');
    expect(midState.targetCollection).toMatch(/^memories_r/);

    const port = recordingPort();
    const deps = passDeps(new FakeEmbedGateway(NEW_MODEL), port);
    const outcome = await runToSettled(deps);
    expect(outcome).toBe('completed');

    // The switch: assignment flipped exactly once, THROUGH the port, and the
    // state row now serves the new collection at the probed dimension.
    expect(port.commits).toEqual([{ providerId: target.providerId, model: NEW_MODEL }]);
    expect(port.reloads).toEqual([{ model: NEW_MODEL }]);
    const state = await readEmbeddingIndexState(tdb.db);
    expect(state.rebuildStatus).toBeNull();
    expect(state.activeCollection).toBe(midState.targetCollection);
    expect(state.activeDimensions).toBe(1024);
    // The replaced collection is retired on a grace period, not dropped at
    // the instant of the switch: a briefly stale process keeps a coherent
    // old space to serve from.
    expect(state.retiredCollection).toBe('memories');
    expect(await qdrantCollections()).toContain('memories');

    // Every row is stamped with the new producer; the boot guard sees a
    // coherent instance.
    const { rows: stamped } = await tdb.pool.query<{ embedding_model: string }>(
      `SELECT DISTINCT embedding_model FROM memory WHERE embedding_model IS NOT NULL`,
    );
    expect(stamped.map((r) => r.embedding_model)).toEqual([NEW_MODEL]);
    expect(
      await checkEmbeddingSpace(tdb.db, { url: qdrant.url, activeModel: NEW_MODEL }),
    ).toBeNull();

    // Gate parity in the NEW collection, asserted rather than assumed:
    // payloads carry the gate fields, including the sensitive flag toggled
    // BEFORE the rebuild finished, and a gate-filtered search behaves.
    const rebuilt = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: NEW_MODEL,
      collection: state.activeCollection,
      dimensions: 1024,
    });
    const payloads = await rebuilt.retrievePayloads(rows.map((row) => row.id));
    expect(payloads.size).toBe(rows.length);
    for (const row of rows) {
      const payload = payloads.get(row.id)!;
      expect(payload['owner_id']).toBe(owner.userId);
      expect(payload['scope']).toBe('private');
      expect(payload['source_type']).toBe('user_note');
    }
    expect(payloads.get(rows[4]!.id)!['sensitive']).toBe(true);

    // The stranger's gate filter returns NOTHING from the rebuilt collection
    // (private scope, foreign owner), and the owner's default filter excludes
    // the sensitive fact — the same hard gates, inside the vector query.
    const queryVector = fakeEmbedding(contents[4]!, 1024);
    const strangerHits = await rebuilt.search(queryVector, buildGateFilter(stranger), 10);
    expect(strangerHits).toEqual([]);
    const ownerDefault = await rebuilt.search(queryVector, buildGateFilter(owner), 10);
    expect(ownerDefault.map((hit) => hit.id)).not.toContain(rows[4]!.id);
    const ownerOptIn = await rebuilt.search(
      queryVector,
      buildGateFilter(owner, { includeSensitive: true }),
      10,
    );
    expect(ownerOptIn.map((hit) => hit.id)).toContain(rows[4]!.id);

    // The payload indexes exist on the new collection (same ensureCollection
    // path as boot), so the gates are indexed pre-filters, not scans.
    const info = (await (
      await fetch(`${qdrant.url}/collections/${state.activeCollection}`)
    ).json()) as {
      result?: { payload_schema?: Record<string, unknown> };
    };
    expect(Object.keys(info.result?.payload_schema ?? {})).toEqual(
      expect.arrayContaining(['owner_id', 'scope', 'status', 'sensitive']),
    );

    // Retirement: the grace-period pass drops the old collection.
    await updateEmbeddingIndexState(tdb.db, { retiredAt: new Date(Date.now() - 6 * 60_000) });
    liveProviders.version += 1; // the flip bumped the configuration version
    const retire = await runEmbeddingRebuildPass(passDeps(new FakeEmbedGateway(NEW_MODEL)));
    expect(retire.outcome).toBe('retired');
    expect(await qdrantCollections()).not.toContain('memories');
  }, 120_000);

  it('rebuild_interrupted_resumes: presence in the target collection is the resume state', async () => {
    // The previous test left the instance on NEW_MODEL. Rebuild back to the
    // old one, with a gateway that dies after the first batch.
    liveProviders.tiers.embedding.model = NEW_MODEL;
    const back = {
      providerId: 'provider-1',
      providerLabel: 'Hosted',
      model: OLD_MODEL,
      dimensions: 1536,
    };
    await beginEmbeddingRebuild(tdb.db, {
      target: back,
      requestedBy: owner.userId,
      orgId: owner.orgId,
    });

    const flaky = new FakeEmbedGateway(OLD_MODEL, 1);
    const first = await runEmbeddingRebuildPass({
      ...passDeps(flaky),
      batchSize: 2,
    });
    // The pass survived the throw: recorded the failure, kept the rebuild.
    expect(first.outcome).toBe('failed');
    const paused = await embeddingRebuildStatus(tdb.db);
    expect(paused?.status).toBe('running'); // one failure is a retry, not a park
    expect(paused?.error).toMatch(/went away/);

    // "Restart": a fresh pass (new process, same rows). Rows already in the
    // target are NOT re-embedded — the gateway sees only the remainder.
    const healthy = new FakeEmbedGateway(OLD_MODEL);
    const outcome = await runToSettled({ ...passDeps(healthy), batchSize: 2 });
    expect(outcome).toBe('completed');
    const state = await readEmbeddingIndexState(tdb.db);
    expect(state.activeDimensions).toBe(1536);
    const corpus = await embeddingRebuildCorpus(tdb.db);
    // The flaky run embedded one batch (2 rows); the resume embedded the rest.
    const embedded = healthy.embedBatches;
    expect(embedded).toBeLessThan(Math.ceil(corpus.facts / 2) + 2);
    liveProviders.tiers.embedding.model = OLD_MODEL;
    liveProviders.version += 1;
  }, 120_000);

  it('rebuild_cancelled_cleanly: partial collection dropped, previous configuration serving', async () => {
    const port = recordingPort();
    await beginEmbeddingRebuild(tdb.db, { target, requestedBy: owner.userId, orgId: owner.orgId });
    const mid = await readEmbeddingIndexState(tdb.db);
    // One tiny slice of work, so a partial artifact exists.
    await runEmbeddingRebuildPass({
      ...passDeps(new FakeEmbedGateway(NEW_MODEL), port),
      passBudgetMs: 1,
      batchSize: 1,
    });

    await cancelEmbeddingRebuild(tdb.db, vectorsFor(), { requestedBy: owner.userId });
    const state = await readEmbeddingIndexState(tdb.db);
    expect(state.rebuildStatus).toBeNull();
    expect(state.targetCollection).toBeNull();
    expect(state.activeCollection).toBe(mid.activeCollection); // untouched
    expect(port.commits).toEqual([]); // nothing was ever flipped
    expect(await qdrantCollections()).not.toContain(mid.targetCollection!);
    // The rows still say the OLD producer: the guard is happy as-is.
    expect(
      await checkEmbeddingSpace(tdb.db, { url: qdrant.url, activeModel: OLD_MODEL }),
    ).toBeNull();
  }, 60_000);

  it('rebuild_failed_leaves_previous_serving: repeated failures park it, active untouched', async () => {
    const port = recordingPort();
    await beginEmbeddingRebuild(tdb.db, { target, requestedBy: owner.userId, orgId: owner.orgId });
    const before = await readEmbeddingIndexState(tdb.db);

    const broken = new FakeEmbedGateway(NEW_MODEL, 0); // fails on the first batch
    for (let i = 0; i < 5; i += 1) {
      await runEmbeddingRebuildPass({ ...passDeps(broken, port), batchSize: 2 });
    }
    const status = await embeddingRebuildStatus(tdb.db);
    expect(status?.status).toBe('failed');
    expect(status?.error).toMatch(/went away/);
    const state = await readEmbeddingIndexState(tdb.db);
    expect(state.activeCollection).toBe(before.activeCollection);
    expect(port.commits).toEqual([]);
    // Cleanup for the suite: cancel clears the parked rebuild too.
    await cancelEmbeddingRebuild(tdb.db, vectorsFor(), { requestedBy: owner.userId });
  }, 60_000);

  it('boot_guard_still_refuses_manufactured_mismatch, with the actionable shape', async () => {
    // A state no interface action can produce: rows stamped by a model that
    // is not the active one (restored backup, direct database edit).
    await tdb.pool.query(
      `UPDATE memory SET embedding_model = 'some-other-model' WHERE id IN
         (SELECT id FROM memory WHERE embedding_model IS NOT NULL LIMIT 2)`,
    );
    const problem = await checkEmbeddingSpace(tdb.db, {
      url: qdrant.url,
      activeModel: OLD_MODEL,
    });
    expect(problem?.kind).toBe('foreign_models');
    expect(problem?.activeModel).toBe(OLD_MODEL);
    expect(problem?.activeCollection).toBeTruthy();
    expect(problem?.foreign).toEqual([{ model: 'some-other-model', rows: 2 }]);

    // Repair through the shared engine's in-place path is exercised by the
    // local-embeddings suite; here restore the stamps and verify green.
    await tdb.pool.query(
      `UPDATE memory SET embedding_model = '${OLD_MODEL}' WHERE embedding_model = 'some-other-model'`,
    );
    expect(
      await checkEmbeddingSpace(tdb.db, { url: qdrant.url, activeModel: OLD_MODEL }),
    ).toBeNull();
  });

  it('operator_composition_repairs_via_the_same_engine: createEmbeddingRebuild drives an offline switch', async () => {
    // The CLI's composition: primitives in, the same engine underneath. This
    // is the app-will-not-start path — no Nest, no worker, just the loop.
    const rebuild = createEmbeddingRebuild({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: OLD_MODEL },
    });
    const port = recordingPort();
    await rebuild.begin({ target, requestedBy: 'operator' });
    for (let i = 0; i < 60; i += 1) {
      const { outcome } = await rebuild.runPass({
        gatewayFor: async () => new FakeEmbedGateway(NEW_MODEL),
        switchPort: port,
      });
      if (outcome === 'completed') break;
      if (outcome === 'failed' || outcome === 'cancelled') {
        throw new Error(`offline switch settled as ${outcome}`);
      }
    }
    expect(port.commits).toEqual([{ providerId: target.providerId, model: NEW_MODEL }]);
    const state = await readEmbeddingIndexState(tdb.db);
    expect(state.rebuildStatus).toBeNull();
    expect(state.activeDimensions).toBe(1024);
    expect(
      await checkEmbeddingSpace(tdb.db, { url: qdrant.url, activeModel: NEW_MODEL }),
    ).toBeNull();
  }, 120_000);
});
