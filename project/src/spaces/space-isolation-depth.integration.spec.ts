import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import type { FactKind, Principal } from '@cogeto/shared';
import { startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryReconciliation, MemoryFileStore } from '../memory/index';
import type {
  MemoryReconciliation,
  MemoryRow,
  MemoryStore,
  MemorySystemStore,
} from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StreamDelta, StructuredExtractionRequest } from '../model-gateway/index';
import {
  CheckedPairStore,
  DreamingService,
  EntityAliasStore,
  ReconciliationService,
} from '../ingestion/index';
import { space } from './persistence/tables';

/**
 * Isolation in depth (docs/features/spaces.md, session 2): the adversarial
 * fixture. Two spaces holding DIRECTLY CONTRADICTORY facts about the same
 * subject — same entity surface form, same user, identical embeddings,
 * admitted into the same nightly window — must yield ZERO findings across
 * the wall and exactly the right findings within each side, through BOTH the
 * inline path and the nightly pass, which have historically had different
 * gates. A leak here is silent and shows up as a finding a customer cannot
 * explain, which is why the fixture is built to catch one rather than to
 * confirm the happy path.
 */

const DIMS = 8;
const EMBED_MODEL = 'test-embed';
/** One shared vector: embedding similarity across the wall is exactly 1. */
const SAME_VEC = [1, 0, 0, 0, 0, 0, 0, 0];
/** Structurally unhelpful vector, so only the subject/alias path can pair. */
const FAR_VEC = [0, 0, 0, 1, 0, 0, 0, 0];

/** A scripted judge so the fixture needs no model; the deterministic quantity
 * arm decides the contradictions, and dedup is scripted `distinct`. */
class ScriptedGateway extends ModelGateway {
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used here
  async *completeStream(): AsyncIterable<StreamDelta> {
    throw new Error('not used');
  }
  async embed(): Promise<number[][]> {
    throw new Error('this fixture never re-embeds');
  }
  embeddingModelId(): string {
    return EMBED_MODEL;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const raw = request.system.includes('same_fact')
      ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
      : { verdict: 'contradicts', direction: null, reason: 'scripted' };
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

describe('space isolation in depth (integration: real Postgres + Qdrant, scripted judge)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let systemStore: MemorySystemStore;
  let reconciliation: MemoryReconciliation;
  let ledger: CheckedPairStore;
  let aliases: EntityAliasStore;
  let spaceA: string;
  let spaceB: string;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    ({ store, systemStore, reconciliation } = createMemoryReconciliation({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    }));
    await store.ensureIndexReady();
    ledger = new CheckedPairStore(tdb.db);
    aliases = new EntityAliasStore(tdb.db);
    const [a] = await tdb.db.insert(space).values({ name: 'Wall A' }).returning();
    const [b] = await tdb.db.insert(space).values({ name: 'Wall B' }).returning();
    spaceA = a!.id;
    spaceB = b!.id;
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const principalFor = (userId: string, spaceId?: string): Principal => ({
    userId,
    name: 'Wall Tester',
    email: null,
    orgId: 'org-wall',
    orgName: 'org-wall',
    roles: [],
    spaceId,
  });

  const engine = () =>
    new ReconciliationService(new ScriptedGateway(), store, reconciliation, ledger, aliases);

  const seed = async (
    owner: string,
    spaceId: string,
    content: string,
    vector: number[],
    opts: { subjectEntity?: string; entities?: string[]; kind?: FactKind } = {},
  ): Promise<MemoryRow> => {
    const row = await store.createFromFact(principalFor(owner, spaceId), {
      content,
      scope: 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      entities: opts.entities ?? [],
      subjectEntity: opts.subjectEntity,
      kind: opts.kind ?? 'fact',
      embeddingModel: EMBED_MODEL,
    });
    await store.upsertVectors([row], [vector]);
    return row;
  };

  const inline = async (rows: MemoryRow[]) => {
    const embeddings = await systemStore.retrieveEmbeddings(rows.map((r) => r.id));
    return tdb.db.transaction(async (tx) =>
      engine().reconcile(
        tx,
        rows.map((row) => ({ row, embedding: embeddings.get(row.id)! })),
        () => {},
        { exclude: 'same_source', detectedBy: 'repair' },
      ),
    );
  };

  const relationsTouching = async (ids: string[]) => {
    const { rows } = await tdb.pool.query<{ a_memory_id: string; b_memory_id: string }>(
      `SELECT a_memory_id, b_memory_id FROM memory_relation
        WHERE a_memory_id = ANY($1) OR b_memory_id = ANY($1)`,
      [ids],
    );
    return rows;
  };

  it('inline_and_nightly_never_pair_across_the_wall: identical contradictory facts in two spaces yield zero cross-space findings and the right within-space one', async () => {
    const owner = `wall-${randomUUID()}`;
    const subject = 'Flange FL-100';
    // Space A holds BOTH sides of a numeric conflict; space B holds one side
    // that directly contradicts A's — same subject surface form, same user,
    // embedding similarity 1.0 across the wall, same nightly window.
    const a1 = await seed(owner, spaceA, 'The FL-100 flange plate is 3.2 mm thick.', SAME_VEC, {
      subjectEntity: subject,
      entities: [subject],
    });
    const a2 = await seed(owner, spaceA, 'The FL-100 flange plate is 3.4 mm thick.', SAME_VEC, {
      subjectEntity: subject,
      entities: [subject],
    });
    const b1 = await seed(owner, spaceB, 'The FL-100 flange plate is 3.6 mm thick.', SAME_VEC, {
      subjectEntity: subject,
      entities: [subject],
    });

    // The INLINE path (per-space batches, the pipeline/repair shape).
    const summaryA = await inline([a2]);
    expect(summaryA.contradictions).toBe(1);
    const summaryB = await inline([b1]);
    expect(summaryB.contradictions).toBe(0);
    expect(summaryB.merged).toBe(0);
    expect(summaryB.superseded).toBe(0);

    // The NIGHTLY pass over the same window, both spaces at once.
    const dreaming = new DreamingService(tdb.db, store, systemStore, engine());
    const report = await dreaming.run(() => {}, {
      scopeFrom: new Date(Date.now() - 3600 * 1000),
    });
    expect(report.considered).toBeGreaterThan(0);

    // Zero findings across the wall; the one finding is A1 vs A2.
    const touching = await relationsTouching([a1.id, a2.id, b1.id]);
    const aIds = new Set([a1.id, a2.id]);
    expect(touching.length).toBeGreaterThanOrEqual(1);
    for (const relation of touching) {
      expect(aIds.has(relation.a_memory_id)).toBe(true);
      expect(aIds.has(relation.b_memory_id)).toBe(true);
    }
    expect(await relationsTouching([b1.id])).toHaveLength(0);

    // The judged-pair ledger holds no cross-space pair and every row carries
    // the pair's one space.
    const ledgerRows = await ledger.forMemories([a1.id, a2.id, b1.id]);
    for (const row of ledgerRows) {
      expect([row.aMemoryId, row.bMemoryId].every((id) => aIds.has(id))).toBe(true);
      expect(row.spaceId).toBe(spaceA);
    }
  });

  it('pair_actions_refuse_a_cross_space_pair: the aggregate is the wall of last resort', async () => {
    const owner = `wall-refuse-${randomUUID()}`;
    const a = await seed(owner, spaceA, 'The valve pressure rating is 16 bar.', SAME_VEC, {
      subjectEntity: 'Valve V-1',
    });
    const b = await seed(owner, spaceB, 'The valve pressure rating is 25 bar.', SAME_VEC, {
      subjectEntity: 'Valve V-1',
    });
    await expect(
      tdb.db.transaction((tx) => reconciliation.createContradiction(tx, a.id, b.id, 'forced')),
    ).rejects.toThrow(/different spaces/);
    await expect(
      tdb.db.transaction((tx) => reconciliation.mergeSameFact(tx, a.id, b.id, null, 'forced')),
    ).rejects.toThrow(/different spaces/);
    await expect(
      tdb.db.transaction((tx) => reconciliation.applySupersession(tx, a.id, b.id, 'forced')),
    ).rejects.toThrow(/different spaces/);
    // And a revision in one space resolves nothing in the other, because the
    // settlement runs over these same pair actions: no relation exists across
    // the wall to resolve, and none can be created to begin with.
    expect(await relationsTouching([a.id, b.id])).toHaveLength(0);
  });

  it('aliases_stay_per_space: one space aliasing a surface form does not leak identity into the other', async () => {
    const owner = `wall-alias-${randomUUID()}`;
    const canonical = 'Arkona Metals';
    const foreign = 'Arkona Metali d.o.o.';
    // The alias is recorded ONLY in space A.
    await aliases.add(owner, canonical, foreign, spaceA);

    // In each space: an anchored fact under the canonical name, then an
    // incoming fact under the foreign surface form with a FAR vector, so the
    // subject/alias expansion is the only path that can pair them.
    const a1 = await seed(owner, spaceA, `${canonical} extended the lease to 2027.`, SAME_VEC, {
      subjectEntity: canonical,
      entities: [canonical],
    });
    const aIncoming = await seed(
      owner,
      spaceA,
      `${foreign} terminated the lease in 2025.`,
      FAR_VEC,
      { subjectEntity: foreign, entities: [foreign] },
    );
    const b1 = await seed(owner, spaceB, `${canonical} extended the lease to 2027.`, SAME_VEC, {
      subjectEntity: canonical,
      entities: [canonical],
    });
    const bIncoming = await seed(
      owner,
      spaceB,
      `${foreign} terminated the lease in 2025.`,
      FAR_VEC,
      { subjectEntity: foreign, entities: [foreign] },
    );

    const summaryA = await inline([aIncoming]);
    const summaryB = await inline([bIncoming]);
    // Space A's recorded alias finds the pair; space B, which never recorded
    // it, must see nothing — the vocabulary is sealed with its corpus.
    expect(summaryA.contradictions).toBe(1);
    expect(summaryB.contradictions).toBe(0);
    expect(await relationsTouching([bIncoming.id, b1.id])).toHaveLength(0);
    expect((await relationsTouching([a1.id, aIncoming.id])).length).toBeGreaterThanOrEqual(1);
    // Two spaces may also alias the same surface form differently without
    // interfering: the per-space unique index accepts the same pair again.
    expect(await aliases.add(owner, 'Something Else', foreign, spaceB)).not.toBeNull();
  });

  it('same_file_in_two_spaces_is_two_first_uploads: checksum dedup never crosses', async () => {
    const owner = `wall-file-${randomUUID()}`;
    const checksum = `sha256-${randomUUID()}`;
    const files = new MemoryFileStore(tdb.db);
    await tdb.db.transaction((tx) =>
      files.record(tx, {
        objectKey: `org/${owner}/private/file-${randomUUID()}`,
        ownerId: owner,
        scope: 'private',
        sensitive: false,
        spaceId: spaceA,
        checksum,
        sizeBytes: 42,
      }),
    );
    // From space B the identical bytes are a FIRST upload, by design.
    expect(await files.findDuplicate(owner, checksum, spaceB)).toBeNull();
    expect(await files.findDuplicate(owner, checksum, spaceA)).not.toBeNull();
    await tdb.db.transaction((tx) =>
      files.record(tx, {
        objectKey: `org/${owner}/private/file-${randomUUID()}`,
        ownerId: owner,
        scope: 'private',
        sensitive: false,
        spaceId: spaceB,
        checksum,
        sizeBytes: 42,
      }),
    );
    // Both now exist independently; each space sees exactly its own copy.
    const inA = await files.findDuplicate(owner, checksum, spaceA);
    const inB = await files.findDuplicate(owner, checksum, spaceB);
    expect(inA).not.toBeNull();
    expect(inB).not.toBeNull();
    expect(inA!.objectKey).not.toBe(inB!.objectKey);
  });

  it('cross_space_invisibility_holds_after_the_jobs_ran: every read primitive stays sealed once reconciliation and dreaming have written', async () => {
    const owner = `wall-reads-${randomUUID()}`;
    const a = await seed(owner, spaceA, 'The commissioning deadline is 2026-10-01.', SAME_VEC, {
      subjectEntity: 'Commissioning',
      entities: ['Commissioning'],
    });
    const b = await seed(owner, spaceB, 'The commissioning deadline is 2026-12-15.', SAME_VEC, {
      subjectEntity: 'Commissioning',
      entities: ['Commissioning'],
    });
    await inline([a]);
    await inline([b]);
    await new DreamingService(tdb.db, store, systemStore, engine()).run(() => {}, {
      scopeFrom: new Date(Date.now() - 3600 * 1000),
    });

    for (const [spaceId, own, foreign] of [
      [spaceA, a, b],
      [spaceB, b, a],
    ] as const) {
      const principal = principalFor(owner, spaceId);
      const listed = await store.listForPrincipal(principal, {});
      expect(listed.some((row) => row.id === foreign.id)).toBe(false);
      expect(listed.some((row) => row.id === own.id)).toBe(true);
      for (const row of listed) expect(row.spaceId).toBe(spaceId);
      const vector = await store.vectorSearch(principal, SAME_VEC, { topK: 10 });
      expect(vector.some((hit) => hit.memoryId === foreign.id)).toBe(false);
      const fts = await store.ftsSearch(principal, 'commissioning deadline', { topK: 10 });
      expect(fts.some((hit) => hit.memory.id === foreign.id)).toBe(false);
      const entity = await store.entitySearch(principal, ['Commissioning'], { topK: 10 });
      expect(entity.some((hit) => hit.memory.id === foreign.id)).toBe(false);
      const byId = await store.getManyForPrincipal(principal, [own.id, foreign.id], {});
      expect(byId.map((row) => row.id)).toEqual([own.id]);
    }
    // The background jobs wrote nothing into the wrong space: every row still
    // carries the space it was admitted into.
    const { rows } = await tdb.pool.query<{ id: string; space_id: string }>(
      `SELECT id, space_id FROM memory WHERE id = ANY($1)`,
      [[a.id, b.id]],
    );
    expect(rows.find((r) => r.id === a.id)?.space_id).toBe(spaceA);
    expect(rows.find((r) => r.id === b.id)?.space_id).toBe(spaceB);
    expect(DEFAULT_SPACE_ID).not.toBe(spaceA);
  });
});
