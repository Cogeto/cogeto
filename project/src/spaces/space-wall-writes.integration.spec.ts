import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import type { Principal } from '@cogeto/shared';
import {
  fakeEmbedding,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { InMemoryDailyCounters } from '../infrastructure/index';
import {
  createMemoryStore,
  MemoryFileStore,
  MemoryObjectStore,
  MemoryReconciliation,
} from '../memory/index';
import type { MemoryStore } from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StreamDelta, StructuredExtractionRequest } from '../model-gateway/index';
import { createIngestionPipeline, createSuppressedFactLog } from '../ingestion/index';
import type { SourceItem, SourceReader } from '../ingestion/index';
import { FileReadReportStore, FilesService } from '../files/index';
import { space } from './persistence/tables';

/**
 * The write side of the wall, proven behaviourally (spaces verification F2 and
 * F3; issues B and C of the wall-holes session):
 *
 * 1. A source ingested in a NON-default space writes its structurally invalid
 *    suppressed entries into THAT space's log, the default space's log sees
 *    nothing, and the gated read agrees from both sides of the wall. This is
 *    exactly the case no single-space test could see, because there the two
 *    spaces coincide.
 * 2. The files service's DISCARDED-source arm and its reprocess fallback
 *    refuse a cross-space owner, matching the metadata arm whose passing test
 *    is what created the false confidence.
 */

const DIMS = 8;
const EMBED_MODEL = 'test-embed';

/** Scripted at the ModelGateway seam, exactly like pipeline.integration.spec:
 * one supported fact plus one structurally invalid fact (blank span). */
class ScriptedGateway extends ModelGateway {
  constructor(private readonly extractOutput: () => unknown) {
    super();
  }
  complete(): never {
    throw new Error('complete() is not used here');
  }
  // eslint-disable-next-line require-yield -- not used here
  async *completeStream(): AsyncIterable<StreamDelta> {
    throw new Error('completeStream() is not used here');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => fakeEmbedding(text, DIMS));
  }
  embeddingModelId(): string {
    return EMBED_MODEL;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const raw = request.input.startsWith('CLAIMS UNDER REVIEW')
      ? {
          verdicts: [...request.input.matchAll(/CLAIM (\d+):/g)].map((m) => ({
            claim: Number(m[1]),
            verdict: 'supported',
            reason: 'scripted',
          })),
        }
      : request.input.startsWith('CLAIM UNDER REVIEW')
        ? { verdict: 'supported', reason: 'scripted' }
        : request.input.startsWith('FACT A:')
          ? { verdict: 'compatible', direction: null, reason: 'scripted' }
          : this.extractOutput();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed the schema', false);
    return parsed.data;
  }
}

/** In-test stage-1 port whose SourceItem carries a NON-default space. */
class SpacedReader implements SourceReader {
  readonly sourceType = 'user_note' as const;
  readonly sources = new Map<string, SourceItem>();

  add(content: string, ownerId: string, spaceId: string): string {
    const sourceId = randomUUID();
    this.sources.set(sourceId, {
      sourceType: this.sourceType,
      sourceId,
      ownerId,
      spaceId,
      content,
      createdAt: new Date('2026-08-20T10:00:00Z'),
    });
    return sourceId;
  }
  async load(sourceId: string): Promise<SourceItem | null> {
    return this.sources.get(sourceId) ?? null;
  }
  async existsForAdmission(_tx: unknown, sourceId: string): Promise<boolean> {
    return this.sources.has(sourceId);
  }
}

describe('space wall on the write side (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let store: MemoryStore;
  let objects: MemoryObjectStore;
  let spaceB: string;

  const OWNER = 'space-wall-owner';

  const principalIn = (spaceId: string): Principal => ({
    userId: OWNER,
    name: 'Owner',
    email: null,
    orgId: 'org-wall',
    orgName: 'Org',
    roles: [],
    spaceId,
  });

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    });
    await store.ensureIndexReady();
    objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    const [row] = await tdb.db.insert(space).values({ name: 'Wall B' }).returning();
    spaceB = row!.id;
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  it('suppressed_entries_land_in_the_sources_own_space: the default log is untouched and the gated read agrees', async () => {
    const supported = 'The kiln ceiling is 1260 C.';
    const gateway = new ScriptedGateway(() => ({
      facts: [
        {
          claim: supported,
          kind: 'fact',
          entities: { people: [], organizations: [], projects: [] },
          condition: null,
          temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
          source_span: supported,
        },
        {
          // Structurally invalid: a whitespace span passes the extraction
          // schema's min(1) but fails structurallyValid, never reaches the
          // verifier, and exists ONLY in the suppressed log — which is why
          // this row was the one that could be misfiled unnoticed (F2).
          claim: 'An unanchored claim about the kiln.',
          kind: 'fact',
          entities: { people: [], organizations: [], projects: [] },
          condition: null,
          temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
          source_span: ' ',
        },
      ],
    }));
    const reader = new SpacedReader();
    const suppressed = createSuppressedFactLog(tdb.db);
    const pipeline = createIngestionPipeline({
      readers: [reader],
      gateway,
      store,
      reconciliation: new MemoryReconciliation(tdb.db, store),
      suppressedFacts: suppressed,
    });
    const sourceId = reader.add(
      'The kiln ceiling is 1260 C. And an unanchored claim.',
      OWNER,
      spaceB,
    );

    const summary = await tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'user_note', source_id: sourceId }),
    );
    expect(summary.notAdmitted).toBe(1);
    expect(summary.admitted.active).toBe(1);

    // The raw rows: the withheld claim's entry carries the SOURCE's space,
    // exactly like the admitted fact's memory row; nothing fell to default.
    const logRows = await tdb.pool.query<{ space_id: string; reason: string }>(
      `SELECT space_id, reason FROM suppressed_fact_log WHERE source_id = $1`,
      [sourceId],
    );
    expect(logRows.rows).toHaveLength(1);
    expect(logRows.rows[0]!.reason).toBe('structurally_invalid');
    expect(logRows.rows[0]!.space_id).toBe(spaceB);
    const memRows = await tdb.pool.query<{ space_id: string }>(
      `SELECT space_id FROM memory WHERE source_id = $1`,
      [sourceId],
    );
    expect(memRows.rows).toHaveLength(1);
    expect(memRows.rows[0]!.space_id).toBe(spaceB);

    // The gated read from both sides of the wall: visible where the source
    // lives, invisible from the default space, same owner both times.
    const inB = await suppressed.list(principalIn(spaceB), { sourceId });
    expect(inB.total).toBe(1);
    const inDefault = await suppressed.list(principalIn(DEFAULT_SPACE_ID), { sourceId });
    expect(inDefault.total).toBe(0);
  });

  it('discarded_source_reads_and_reprocess_refuse_across_the_wall: the owner exception does not exist on the fallback arms either', async () => {
    // A discard-mode source: derived memories carry the file key as
    // provenance, but there is no file_metadata row — the arm F3 found open.
    const objectKey = `org-wall/${OWNER}/private/file-${randomUUID()}`;
    await store.createFromFact(principalIn(spaceB), {
      content: 'The manual names a 90 minute soak.',
      scope: 'private',
      sourceType: 'file',
      sourceId: objectKey,
    });

    const files = new FilesService(
      tdb.db,
      objects,
      new MemoryFileStore(tdb.db),
      store,
      { uploadMaxBytes: 25 * 1024 * 1024, downloadUrlTtlSeconds: 300 },
      new InMemoryDailyCounters(),
      { captureMax: 1_000_000, uploadMax: 1_000_000 },
      new FileReadReportStore(tdb.db),
    );

    // From the space it lives in: readable, honestly marked discarded.
    const own = await files.getSourceForOwner(principalIn(spaceB), objectKey);
    expect(own?.discarded).toBe(true);
    // From the default space, same owner: not found — no metadata leak.
    expect(await files.getSourceForOwner(principalIn(DEFAULT_SPACE_ID), objectKey)).toBeNull();

    // Reprocess, same shape: refused across the wall; in its own space the
    // discarded original honestly reports there is nothing left to re-read.
    expect(await files.reprocess(principalIn(DEFAULT_SPACE_ID), objectKey)).toBeNull();
    expect(await files.reprocess(principalIn(spaceB), objectKey)).toEqual({ queued: false });
  });
});
