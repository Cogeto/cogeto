import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { ensureInstanceKeys, idempotentTask, loadInstancePublicKey } from '../infrastructure/index';
import {
  fakeEmbedding,
  makePdf,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import {
  EmailAllowlistService,
  EmailIntakeService,
  EmailSourceDeletion,
  EmailSourceReader,
  FileSourceReader,
  UserSettingsService,
} from '../connectors/index';
import { UserDirectory } from '../identity/index';
import { INGESTION_PIPELINE_JOB_TYPE, createIngestionPipeline } from '../ingestion/index';
import { MemoryStore } from './memory.store';
import { MemoryReconciliation } from './reconciliation';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { MemoryFileStore } from './file-store';
import {
  DELETION_JOB_TYPE,
  DeletionExecutor,
  DeletionSaga,
  parseReceiptCounts,
} from './deletion-saga';
import { createIntegritySweep } from './factory';
import { verifyChain } from './domain/receipt-chain';
import type { ConfirmedReceipt } from './domain/receipt-chain';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';
const COLLECTION = 'email-cascade-test';
const INBOUND = 'capture@in.localhost';

const owner: Principal = {
  userId: 'user-mail',
  name: 'Mail Owner',
  email: 'owner@instance.test',
  orgId: 'org-mail',
  orgName: 'Org',
  roles: [],
};

/** Scripted gateway: one fact per source, verify supported, reconcile distinct. */
class ScriptedGateway extends ModelGateway {
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unused');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return EMBED_MODEL;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    let raw: unknown;
    if (request.input.startsWith('CLAIM UNDER REVIEW')) {
      raw = { verdict: 'supported', reason: 'scripted' };
    } else if (request.input.startsWith('FACT A:')) {
      raw = { verdict: 'distinct', reason: 'scripted', merged_content: null };
    } else {
      const content = (request.input.split('SOURCE CONTENT:\n')[1] ?? '').trim();
      const claim = content.split('\n').filter(Boolean).pop() ?? 'a durable fact';
      raw = {
        facts: [
          {
            claim,
            kind: 'commitment',
            entities: { people: [], organizations: [], projects: [] },
            condition: null,
            temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
            source_span: claim.slice(0, 40),
          },
        ],
      };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

/** Build a multipart/mixed email with a plain body, a large HTML part, and a PDF. */
function rawEmailWithAttachment(pdf: Buffer): Buffer {
  const boundary = 'BOUNDARY123';
  const bigHtml = `<p>${'x'.repeat(300_000)}</p>`; // > 256 KB → HTML externalised to MinIO
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nAna will deliver the Atlas proposal on Monday.\r\n`,
    `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${bigHtml}\r\n`,
    `--${boundary}\r\nContent-Type: application/pdf; name="brief.pdf"\r\n` +
      `Content-Disposition: attachment; filename="brief.pdf"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n${pdf.toString('base64').replace(/(.{76})/g, '$1\r\n')}\r\n`,
  ];
  const head = [
    'From: ana@adriatic-foods.hr',
    `To: ${INBOUND}`,
    'Subject: Atlas',
    'Message-ID: <cascade@cogeto.test>',
    'Date: Tue, 14 Jul 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join('\r\n');
  return Buffer.from(`${head}\r\n\r\n${parts.join('')}--${boundary}--\r\n`);
}

describe('email deletion cascade (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let keyDir: string;
  let vectors: MemoryVectorStore;
  let objects: MemoryObjectStore;
  let store: MemoryStore;
  let fileStore: MemoryFileStore;
  let intake: EmailIntakeService;
  let saga: DeletionSaga;
  let executor: DeletionExecutor;

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    keyDir = mkdtempSync(path.join(tmpdir(), 'cogeto-email-cascade-keys-'));
    await ensureInstanceKeys(keyDir);
    vectors = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: EMBED_MODEL,
      dimensions: DIMS,
      collection: COLLECTION,
    });
    await vectors.ensureCollection();
    objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    await objects.setBucketEncryption();
    store = new MemoryStore(tdb.db, vectors);
    fileStore = new MemoryFileStore(tdb.db);
    const allowlist = new EmailAllowlistService(tdb.db);
    const directory = new UserDirectory(tdb.db);
    await directory.record(owner);
    await allowlist.addEntry(owner, { kind: 'domain', value: 'adriatic-foods.hr' });
    intake = new EmailIntakeService(
      tdb.db,
      objects,
      fileStore,
      allowlist,
      directory,
      new UserSettingsService(tdb.db),
      {
        inboundAddress: INBOUND,
        maxBytes: 25 * 1024 * 1024,
        attachmentsMaxBytes: 25 * 1024 * 1024,
        adminUserEmail: null,
        intakeToken: 't',
      },
    );
    saga = new DeletionSaga(tdb.db, [new EmailSourceDeletion()], vectors);
    executor = new DeletionExecutor(vectors, objects, keyDir);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  const gateway = new ScriptedGateway();
  const pipeline = () =>
    createIngestionPipeline({
      readers: [new EmailSourceReader(tdb.db), new FileSourceReader(fileStore, objects)],
      gateway,
      store,
      reconciliation: new MemoryReconciliation(tdb.db, store, vectors),
    });
  const taskList = (): TaskList => ({
    [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
      tdb.db,
      INGESTION_PIPELINE_JOB_TYPE,
      async (tx, payload) => {
        await pipeline().run(tx, payload);
      },
    ),
    [DELETION_JOB_TYPE]: idempotentTask(tdb.db, DELETION_JOB_TYPE, async (tx, payload) => {
      await executor.execute(tx, payload.source_id);
    }),
  });
  const runWorker = () => runOnce({ pgPool: tdb.pool, taskList: taskList() });

  const memCount = async (type: string, id: string): Promise<number> =>
    Number(
      (
        await tdb.pool.query(
          'SELECT count(*)::text AS n FROM memory WHERE source_type = $1 AND source_id = $2',
          [type, id],
        )
      ).rows[0].n,
    );
  const receipt = async (id: string) =>
    (await tdb.pool.query('SELECT * FROM deletion_receipt WHERE id = $1', [id])).rows[0] as
      { status: string; counts_json: unknown } | undefined;

  it('email_deletion_cascade: email + attachment + memories fully removed with an honest, confirmed receipt', async () => {
    const pdf = makePdf('Atlas brief: the renewal is worth forty-eight thousand euros.');
    const result = await intake.intake(rawEmailWithAttachment(pdf), {
      mailFrom: 'ana@adriatic-foods.hr',
      rcptTo: INBOUND,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const emailId = result.emailIds[0]!;

    // The stored message: raw + externalised HTML objects, and the attachment
    // file source key.
    const msg = (
      await tdb.pool.query(
        'SELECT raw_object_key, html_object_key FROM email_message WHERE id = $1',
        [emailId],
      )
    ).rows[0] as { raw_object_key: string; html_object_key: string | null };
    const att = (
      await tdb.pool.query(
        'SELECT file_object_key FROM email_attachment WHERE email_id = $1 AND file_object_key IS NOT NULL',
        [emailId],
      )
    ).rows[0] as { file_object_key: string };
    expect(msg.html_object_key).not.toBeNull(); // large HTML externalised
    const rawKey = msg.raw_object_key;
    const htmlKey = msg.html_object_key!;
    const attKey = att.file_object_key;

    // Extract both the email body and the attachment.
    await runWorker();
    await runWorker();
    expect(await memCount('email', emailId)).toBeGreaterThan(0);
    expect(await memCount('file', attKey)).toBeGreaterThan(0);
    for (const key of [rawKey, htmlKey, attKey]) {
      expect(await objects.objectExists(key)).toBe(true);
    }
    const allMemoryIds = (
      await tdb.pool.query<{ id: string }>(
        "SELECT id FROM memory WHERE (source_type='email' AND source_id=$1) OR (source_type='file' AND source_id=$2)",
        [emailId, attKey],
      )
    ).rows.map((r) => r.id);
    expect((await vectors.retrievePayloads(allMemoryIds)).size).toBe(allMemoryIds.length);

    // Preview counts the whole cascade (body + attachment memories; raw + html +
    // attachment objects).
    const preview = await saga.previewSourceDeletion(owner, 'email', emailId);
    expect(preview.memoryCount).toBe(allMemoryIds.length);
    expect(preview.objectCount).toBe(3);

    // Saga step one — enumeration transaction: every row gone.
    const { receiptId } = await saga.requestSourceDeletion(owner, 'email', emailId);
    expect(await memCount('email', emailId)).toBe(0);
    expect(await memCount('file', attKey)).toBe(0);
    expect(
      (await tdb.pool.query('SELECT 1 FROM email_message WHERE id = $1', [emailId])).rows.length,
    ).toBe(0);
    expect(
      (await tdb.pool.query('SELECT 1 FROM email_attachment WHERE email_id = $1', [emailId])).rows
        .length,
    ).toBe(0);
    expect(
      (await tdb.pool.query('SELECT 1 FROM file_metadata WHERE object_key = $1', [attKey])).rows
        .length,
    ).toBe(0);
    expect((await receipt(receiptId))?.status).toBe('pending');

    // Steps two + three — worker: all objects + points erased, receipt confirmed.
    await runWorker();
    const confirmed = await receipt(receiptId);
    expect(confirmed?.status).toBe('confirmed');
    for (const key of [rawKey, htmlKey, attKey]) {
      expect(await objects.objectExists(key)).toBe(false);
    }
    expect((await vectors.retrievePayloads(allMemoryIds)).size).toBe(0);

    // The receipt is honest: it counts every memory and every object.
    const counts = parseReceiptCounts(confirmed!.counts_json);
    expect(new Set(counts.memory_ids)).toEqual(new Set(allMemoryIds));
    expect(new Set(counts.object_keys)).toEqual(new Set([rawKey, htmlKey, attKey]));

    // The chain verifies and the sweep finds zero residue.
    const rows = (await tdb.pool.query("SELECT * FROM deletion_receipt WHERE status='confirmed'"))
      .rows as Record<string, unknown>[];
    const chain: ConfirmedReceipt[] = rows.map((r) => ({
      id: r['id'] as string,
      source_type: r['source_type'] as string,
      source_id: r['source_id'] as string,
      counts_json: r['counts_json'],
      signed_at: (r['signed_at'] as Date).toISOString(),
      confirmed_at: (r['confirmed_at'] as Date).toISOString(),
      prev_hash: r['prev_hash'] as string,
      hash: r['hash'] as string,
      signature: r['signature'] as string,
    }));
    const publicKey = await loadInstancePublicKey(keyDir);
    expect(verifyChain(chain, publicKey).ok).toBe(true);

    const sweep = createIntegritySweep({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: EMBED_MODEL,
        dimensions: DIMS,
        collection: COLLECTION,
      },
      s3: {
        url: minio.url,
        accessKey: minio.accessKey,
        secretKey: minio.secretKey,
        bucket: 'cogeto',
      },
      instanceKeyDir: keyDir,
      sourceDeletions: [new EmailSourceDeletion()],
    });
    const report = await sweep.run();
    expect(report.newAlerts).toBe(0);
    expect(report.chainOk).toBe(true);
  });
});
