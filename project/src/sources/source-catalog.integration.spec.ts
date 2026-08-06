import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import {
  createMemoryReconciliation,
  MemoryObjectStore,
  type MemoryStore,
  type MemoryReconciliation,
} from '../memory/index';
import {
  createIngestionPipeline,
  createSuppressedFactLog,
  createSourceContextStore,
  SuppressedFactLog,
  SourceContextStore,
} from '../ingestion/index';
import type { IngestionPipeline, SourceItem, SourceReader } from '../ingestion/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StreamDelta, StructuredExtractionRequest } from '../model-gateway/index';
import { SourceCatalogService } from './source-catalog.service';

const DIMS = 8;
const EMBED = 'test-embed';

class ScriptedGateway extends ModelGateway {
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused
  async *completeStream(): AsyncIterable<StreamDelta> {
    throw new Error('unused');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return EMBED;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    let raw: unknown;
    if (request.input.startsWith('CLAIMS UNDER REVIEW')) {
      raw = {
        verdicts: [...request.input.matchAll(/CLAIM (\d+):/g)].map((m) => ({
          claim: Number(m[1]),
          verdict: 'supported',
          reason: 'scripted',
        })),
      };
    } else if (request.input.startsWith('CLAIM UNDER REVIEW')) {
      raw = { verdict: 'supported', reason: 'scripted' };
    } else if (request.input.startsWith('FACT A:')) {
      raw = { verdict: 'distinct', reason: 'scripted', merged_content: null };
    } else {
      // A real extractor quotes from INSIDE the untrusted fence; mirroring
      // that keeps the framing guards honest and lets the span locate.
      const fenced = request.input.match(
        /-----BEGIN UNTRUSTED DATA [0-9a-f]+-----\n([\s\S]*?)\n-----END UNTRUSTED DATA/,
      );
      const content = (fenced?.[1] ?? request.input).trim();
      raw = {
        facts: [
          {
            claim: content,
            kind: 'fact',
            entities: { people: [], organizations: [], projects: [] },
            condition: null,
            temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
            // A span that sits inside the first (and only) reader segment.
            source_span: content.slice(0, 30),
          },
        ],
      };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

const principalFor = (userId: string): Principal => ({
  userId,
  name: `name-${userId}`,
  email: null,
  orgId: `org-${userId}`,
  orgName: `org-${userId}`,
  roles: [],
});

describe('source catalog (integration: real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let reconciliation: MemoryReconciliation;
  let catalog: SourceCatalogService;
  let suppressedLog: SuppressedFactLog;
  let contextStore: SourceContextStore;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    ({ store, reconciliation } = createMemoryReconciliation({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED, dimensions: DIMS },
    }));
    await store.ensureIndexReady();
    suppressedLog = createSuppressedFactLog(tdb.db);
    contextStore = createSourceContextStore(tdb.db);
    // No MinIO in this suite: the object store is only touched for FILE rows'
    // names and ownership, and every case here uses row-backed types.
    const objects = { statObject: async () => null } as unknown as MemoryObjectStore;
    catalog = new SourceCatalogService(
      tdb.db,
      store,
      reconciliation,
      objects,
      suppressedLog,
      contextStore,
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  /** A reader stub for note rows that ALSO emits one locator segment, so the
   * admission-time span location is exercised without reader binaries. */
  const readerFor = (ownerId: string, noteId: string, content: string): SourceReader => ({
    sourceType: 'user_note',
    async load(): Promise<SourceItem> {
      return {
        sourceType: 'user_note',
        sourceId: noteId,
        ownerId,
        content,
        createdAt: new Date(),
        scope: 'private',
        authoredByUser: true,
        segments: [{ start: 0, end: content.length, locator: { kind: 'paragraph', paragraph: 3 } }],
      };
    },
    async existsForAdmission(): Promise<boolean> {
      return true;
    },
  });

  const pipelineFor = (reader: SourceReader): IngestionPipeline =>
    createIngestionPipeline({
      readers: [reader],
      gateway: new ScriptedGateway(),
      store,
      reconciliation,
      suppressedFacts: suppressedLog,
    });

  const seedNote = async (ownerId: string, content: string): Promise<string> =>
    (
      await tdb.pool.query<{ id: string }>(
        `INSERT INTO note (owner_id, content) VALUES ($1, $2) RETURNING id`,
        [ownerId, content],
      )
    ).rows[0]!.id;

  it('locators_persist_at_admission: the span resolves once, where the segments are', async () => {
    const ownerId = `cat-loc-${randomUUID()}`;
    const noteId = await seedNote(ownerId, 'The Meridian audit closes on 12 September.');
    const pipeline = pipelineFor(
      readerFor(ownerId, noteId, 'The Meridian audit closes on 12 September.'),
    );
    await tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'user_note', source_id: noteId }),
    );

    const rows = await tdb.pool.query(
      `SELECT v.span_locators FROM verification_result v
        JOIN memory m ON m.id = v.memory_id
       WHERE m.source_type = 'user_note' AND m.source_id = $1`,
      [noteId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.rows[0]!['span_locators']).toEqual([{ kind: 'paragraph', paragraph: 3 }]);
  });

  it('catalog_lists_only_the_owners_sources: the gate is structural', async () => {
    const ownerId = `cat-own-${randomUUID()}`;
    const strangerId = `cat-str-${randomUUID()}`;
    const noteId = await seedNote(ownerId, 'Vela Marine moved to 15-day payment terms.');
    const pipeline = pipelineFor(
      readerFor(ownerId, noteId, 'Vela Marine moved to 15-day payment terms.'),
    );
    await tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'user_note', source_id: noteId }),
    );

    const mine = await catalog.list(principalFor(ownerId), {});
    const mineRow = mine.items.find((item) => item.sourceId === noteId);
    expect(mineRow).toBeDefined();
    expect(mineRow!.factCount).toBeGreaterThanOrEqual(1);
    expect(mineRow!.name).toContain('Vela Marine');

    const theirs = await catalog.list(principalFor(strangerId), {});
    expect(theirs.items.find((item) => item.sourceId === noteId)).toBeUndefined();
  });

  it('badge_filter_drives_from_the_condition: every source with a contradiction', async () => {
    const ownerId = `cat-contra-${randomUUID()}`;
    const noteA = await seedNote(ownerId, 'The wall is 3.2 mm.');
    const noteB = await seedNote(ownerId, 'The wall is 3.4 mm.');
    const insertMemory = async (noteId: string, content: string) =>
      (
        await tdb.pool.query<{ id: string }>(
          `INSERT INTO memory (owner_id, scope, content, status, source_type, source_id)
           VALUES ($1, 'private', $2, 'active', 'user_note', $3) RETURNING id`,
          [ownerId, content, noteId],
        )
      ).rows[0]!.id;
    const a = await insertMemory(noteA, 'The wall is 3.2 mm.');
    const b = await insertMemory(noteB, 'The wall is 3.4 mm.');
    await tdb.pool.query(
      `INSERT INTO memory_relation (a_memory_id, b_memory_id, kind, a_prior_status, b_prior_status, reason)
       VALUES ($1, $2, 'contradicts', 'active', 'active', 'scripted')`,
      [a, b],
    );

    const flagged = await catalog.list(principalFor(ownerId), { badge: 'contradicted' });
    const ids = flagged.items.map((item) => item.sourceId).sort();
    expect(ids).toEqual([noteA, noteB].sort());
    expect(flagged.items[0]!.badges.contradictions).toBe(1);

    const stranger = await catalog.list(principalFor(`cat-x-${randomUUID()}`), {
      badge: 'contradicted',
    });
    expect(stranger.items).toEqual([]);
  });

  it('inspection_is_owner_only_and_complete: facts, verification, suppressed', async () => {
    const ownerId = `cat-insp-${randomUUID()}`;
    const noteId = await seedNote(ownerId, 'Adriatic Foods has 30-day terms.');
    const pipeline = pipelineFor(readerFor(ownerId, noteId, 'Adriatic Foods has 30-day terms.'));
    await tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'user_note', source_id: noteId }),
    );
    await tdb.pool.query(
      `INSERT INTO suppressed_fact_log
         (owner_id, scope, sensitive, source_type, source_id, fact_content, source_span, reason)
       VALUES ($1, 'private', false, 'user_note', $2, 'a withheld claim', 'its span', 'structurally_invalid')`,
      [ownerId, noteId],
    );

    const inspection = await catalog.inspect(principalFor(ownerId), 'user_note', noteId);
    expect(inspection.facts.length).toBeGreaterThanOrEqual(1);
    expect(inspection.facts[0]!.verification?.verdict).toBe('supported');
    expect(inspection.facts[0]!.verification?.spanLocators).toEqual([
      { kind: 'paragraph', paragraph: 3 },
    ]);
    expect(inspection.suppressed.map((entry) => entry.factContent)).toContain('a withheld claim');

    // A stranger gets the same NotFound an absent source gets.
    await expect(
      catalog.inspect(principalFor(`cat-peer-${randomUUID()}`), 'user_note', noteId),
    ).rejects.toThrow(/not found/i);
    await expect(catalog.inspect(principalFor(ownerId), 'user_note', randomUUID())).rejects.toThrow(
      /not found/i,
    );
  });
});
