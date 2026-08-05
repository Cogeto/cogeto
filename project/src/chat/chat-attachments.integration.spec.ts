import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import {
  fakeEmbedding,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { listQueuedJobs } from '../infrastructure/index';
import { createMemoryReconciliation, MemoryObjectStore } from '../memory/index';
import {
  createIngestionPipeline,
  createSuppressedFactLog,
  FILE_DISCARD_CLEANUP_JOB_TYPE,
  IngestionProgressStore,
  pipelineStageFor,
} from '../ingestion/index';
import { LadderedDocumentReader } from '../files/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StreamDelta, StructuredExtractionRequest } from '../model-gateway/index';
import { UserSettingsService } from '../settings/index';
import { ChatSourceReader } from './chat.source-reader';
import { ChatAttachmentReadService } from './attachment-read';
import { chatAttachment, chatMessage, conversation } from './persistence/tables';

const DIMS = 8;
const EMBED = 'test-embed';

/** Extraction/verification/reconcile scripted at the gateway seam. */
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
      const content = request.input.split('SOURCE CONTENT:\n')[1] ?? request.input;
      raw = {
        facts: [
          {
            claim: content,
            kind: 'fact',
            entities: { people: [], organizations: [], projects: [] },
            condition: null,
            temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
            source_span: content.slice(0, 40),
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

describe('chat attachments (integration: real Postgres + MinIO + Qdrant)', () => {
  let tdb: TestDatabase;
  let minio: TestMinio;
  let qdrant: TestQdrant;
  let objects: MemoryObjectStore;
  let readService: ChatAttachmentReadService;

  beforeAll(async () => {
    [tdb, minio, qdrant] = await Promise.all([
      startTestDatabase(),
      startTestMinio(),
      startTestQdrant(),
    ]);
    objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    readService = new ChatAttachmentReadService(tdb.db, objects, new LadderedDocumentReader());
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), minio.stop(), qdrant.stop()]);
  });

  const seedConversation = async (ownerId: string): Promise<string> => {
    const [row] = await tdb.db.insert(conversation).values({ ownerId }).returning();
    return row!.id;
  };

  const seedTransient = async (
    ownerId: string,
    conversationId: string,
    bytes: Buffer,
    contentType: string,
    name: string,
  ) => {
    const stagingKey = `org-${ownerId}/${ownerId}/staging/file-${randomUUID()}`;
    await objects.putObject(stagingKey, bytes, {
      contentType,
      metadata: { 'original-filename': encodeURIComponent(name), 'owner-id': ownerId },
    });
    const [row] = await tdb.db
      .insert(chatAttachment)
      .values({
        ownerId,
        conversationId,
        transient: true,
        stagingKey,
        displayName: name,
        contentType,
        sizeBytes: bytes.length,
      })
      .returning();
    return { row: row!, stagingKey };
  };

  it('transient_read_stores_text_and_never_creates_a_source: the honest storage answer', async () => {
    const ownerId = `att-transient-${randomUUID()}`;
    const conv = await seedConversation(ownerId);
    const csv = Buffer.from('supplier,days\nAdriatic Foods,30\n', 'utf8');
    const { row, stagingKey } = await seedTransient(ownerId, conv, csv, 'text/csv', 'terms.csv');

    const result = await tdb.db.transaction((tx) => readService.run(tx, row.id));
    expect(result.read).toBe(true);

    const after = (await tdb.pool.query(`SELECT * FROM chat_attachment WHERE id = $1`, [row.id]))
      .rows[0] as Record<string, unknown>;
    // The text is here — column context on the row, the spreadsheet rule.
    expect(after['status']).toBe('ready');
    expect(String(after['content_text'])).toContain('Adriatic Foods');
    expect(after['read_outcome']).toBe('read');
    // The staging pointer is gone the moment the text is durable; the actual
    // byte deletion is the enqueued cleanup job (commit-then-delete).
    expect(after['staging_key']).toBeNull();
    const queued = await listQueuedJobs(tdb.db);
    const cleanup = queued.filter(
      (job) =>
        job.jobType === FILE_DISCARD_CLEANUP_JOB_TYPE && job.payload?.['source_id'] === stagingKey,
    );
    expect(cleanup.length).toBe(1);

    // Never a source, never a fact: no file_metadata, no memory rows, no
    // pipeline job — transient means transient.
    for (const [table, where] of [
      ['file_metadata', `object_key = '${stagingKey}'`],
      ['memory', `owner_id = '${ownerId}'`],
      ['file_read_report', `owner_id = '${ownerId}'`],
    ] as const) {
      const left = await tdb.pool.query(`SELECT 1 FROM ${table} WHERE ${where}`);
      expect({ table, rows: left.rows.length }).toEqual({ table, rows: 0 });
    }
  });

  it('transient_read_is_idempotent: a duplicate delivery changes nothing', async () => {
    const ownerId = `att-idem-${randomUUID()}`;
    const conv = await seedConversation(ownerId);
    const csv = Buffer.from('a,b\n1,2\n', 'utf8');
    const { row } = await seedTransient(ownerId, conv, csv, 'text/csv', 'once.csv');

    await tdb.db.transaction((tx) => readService.run(tx, row.id));
    const second = await tdb.db.transaction((tx) => readService.run(tx, row.id));
    expect(second.read).toBe(false);
  });

  it('unreadable_transient_records_the_honest_reason_and_completes', async () => {
    const ownerId = `att-unread-${randomUUID()}`;
    const conv = await seedConversation(ownerId);
    // An OLE2 compound file signature: a pre-2007 Office document, detected
    // and refused with the reason that tells the user what to do.
    const legacy = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ]);
    const { row } = await seedTransient(
      ownerId,
      conv,
      legacy,
      'application/msword',
      'contract.doc',
    );

    // The job COMPLETES: an unreadable file is an outcome, not a retry loop.
    const result = await tdb.db.transaction((tx) => readService.run(tx, row.id));
    expect(result.read).toBe(true);
    const after = (
      await tdb.pool.query(
        `SELECT status, read_outcome, read_reason, content_text FROM chat_attachment WHERE id = $1`,
        [row.id],
      )
    ).rows[0] as Record<string, unknown>;
    expect(after['status']).toBe('failed');
    expect(after['read_outcome']).toBe('unsupported_format');
    expect(after['read_reason']).toBe('legacy_office_format');
    expect(after['content_text']).toBeNull();
  });

  it('pipeline_reports_honest_stages: the progress row a card can watch', async () => {
    const ownerId = `att-progress-${randomUUID()}`;
    const conv = await seedConversation(ownerId);
    const [msg] = await tdb.db
      .insert(chatMessage)
      .values({
        ownerId,
        conversationId: conv,
        role: 'user',
        content: 'The Meridian audit closes on Friday.',
      })
      .returning();

    const { store, reconciliation } = createMemoryReconciliation({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED, dimensions: DIMS },
    });
    await store.ensureIndexReady();
    const progress = new IngestionProgressStore(tdb.db);
    const pipeline = createIngestionPipeline({
      readers: [new ChatSourceReader(tdb.db, new UserSettingsService(tdb.db))],
      gateway: new ScriptedGateway(),
      store,
      reconciliation,
      suppressedFacts: createSuppressedFactLog(tdb.db),
      progress,
    });
    await tdb.db.transaction((tx) => pipeline.run(tx, { source_type: 'chat', source_id: msg!.id }));

    // The run reported each stage on its own connection; the LAST stage the
    // run entered is what remains readable (terminal state stays the queue's).
    const stage = await pipelineStageFor(tdb.db, { sourceType: 'chat', sourceId: msg!.id });
    expect(stage).toBe('storing');
  });

  it('count_open_contradictions_for_source: the card counts only its own source', async () => {
    const ownerId = `att-contra-${randomUUID()}`;
    const principal = principalFor(ownerId);
    const { store, reconciliation } = createMemoryReconciliation({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED, dimensions: DIMS },
    });
    await store.ensureIndexReady();

    const insert = async (sourceId: string, content: string) =>
      (
        await tdb.pool.query<{ id: string }>(
          `INSERT INTO memory (owner_id, scope, content, status, source_type, source_id)
           VALUES ($1, 'private', $2, 'active', 'file', $3) RETURNING id`,
          [ownerId, content, sourceId],
        )
      ).rows[0]!.id;
    const fileA = `org-${ownerId}/${ownerId}/private/file-${randomUUID()}`;
    const fileB = `org-${ownerId}/${ownerId}/private/file-${randomUUID()}`;
    const a = await insert(fileA, 'the wall is 3.2 mm');
    const b = await insert(fileB, 'the wall is 3.4 mm');
    await tdb.pool.query(
      `INSERT INTO memory_relation (a_memory_id, b_memory_id, kind, a_prior_status, b_prior_status, reason)
       VALUES ($1, $2, 'contradicts', 'active', 'active', 'scripted')`,
      [a, b],
    );

    // The relation counts for BOTH sources it touches, and for no other.
    expect(await reconciliation.countOpenContradictionsForSource(principal, 'file', fileA)).toBe(1);
    expect(await reconciliation.countOpenContradictionsForSource(principal, 'file', fileB)).toBe(1);
    expect(
      await reconciliation.countOpenContradictionsForSource(
        principal,
        'file',
        `org-x/none/private/file-${randomUUID()}`,
      ),
    ).toBe(0);
  });
});
