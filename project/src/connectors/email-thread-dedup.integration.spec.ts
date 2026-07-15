import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { idempotentTask } from '../infrastructure/index';
import {
  fakeEmbedding,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { createMemoryReconciliation, MemoryFileStore, MemoryObjectStore } from '../memory/index';
import type { MemoryReconciliation, MemoryStore } from '../memory/index';
import { INGESTION_PIPELINE_JOB_TYPE, createIngestionPipeline } from '../ingestion/index';
import type { IngestionPipeline } from '../ingestion/index';
import { UserDirectory } from '../identity/index';
import { EmailAllowlistService } from './email-allowlist.service';
import { EmailIntakeService } from './email-intake.service';
import { UserSettingsService } from './user-settings.service';
import { EmailSourceReader } from './email.source-reader';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';
const COLLECTION = 'email-thread-dedup';
const INBOUND = 'capture@in.localhost';
// The single fact both messages in the thread state — identical, so the second
// is a dedup candidate of the first.
const FIXED_CLAIM = 'The user will send the signed proposal to Ana by Friday.';

const owner: Principal = {
  userId: 'user-mail',
  name: 'Owner',
  email: 'owner@instance.test',
  orgId: 'org-mail',
  orgName: 'Org',
  roles: [],
};

/** Extracts the SAME fact for every email; verify supported; dedup → same_fact. */
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
      // Dedup judge (its prompt mentions same_fact) → merge; contradiction judge
      // → compatible (identical facts do not contradict).
      raw = request.system.includes('same_fact')
        ? { verdict: 'same_fact', reason: 'one fact twice', merged_content: null }
        : { verdict: 'compatible', direction: null, reason: 'scripted' };
    } else {
      raw = {
        facts: [
          {
            claim: FIXED_CLAIM,
            kind: 'commitment',
            entities: { people: ['Ana'], organizations: [], projects: [] },
            condition: null,
            temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
            source_span: FIXED_CLAIM.slice(0, 40),
          },
        ],
      };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

function threadEmail(subject: string, body: string): Buffer {
  return Buffer.from(
    [
      'From: ana@adriatic-foods.hr',
      `To: ${INBOUND}`,
      `Subject: ${subject}`,
      `Message-ID: <${Math.random().toString(36).slice(2)}@cogeto.test>`,
      'Date: Tue, 14 Jul 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
      '',
    ].join('\r\n'),
  );
}

describe('email thread dedup (integration: reconciliation over a reply chain)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let objects: MemoryObjectStore;
  let store: MemoryStore;
  let reconciliation: MemoryReconciliation;
  let intake: EmailIntakeService;

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    ({ store, reconciliation } = createMemoryReconciliation({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: EMBED_MODEL,
        dimensions: DIMS,
        collection: COLLECTION,
      },
    }));
    await store.ensureIndexReady();
    const fileStore = new MemoryFileStore(tdb.db);
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
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  const gateway = new ScriptedGateway();
  const buildPipeline = (): IngestionPipeline =>
    createIngestionPipeline({
      readers: [new EmailSourceReader(tdb.db)],
      gateway,
      store,
      reconciliation,
    });
  const runWorker = () =>
    runOnce({
      pgPool: tdb.pool,
      taskList: {
        [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
          tdb.db,
          INGESTION_PIPELINE_JOB_TYPE,
          async (tx, payload) => {
            await buildPipeline().run(tx, payload);
          },
        ),
      } as TaskList,
    });

  it('thread_dedup: the same fact restated in a reply is not duplicated — reconciliation merges it', async () => {
    // Message 1 states the commitment.
    const first = await intake.intake(
      threadEmail('Proposal', 'I will send the signed proposal to Ana by Friday.'),
      { mailFrom: 'ana@adriatic-foods.hr', rcptTo: INBOUND },
    );
    expect(first.accepted).toBe(true);
    await runWorker();

    // Message 2 (a reply) restates the SAME commitment as its new content; the
    // quoted prior message is stripped, but the restatement remains.
    const second = await intake.intake(
      threadEmail(
        'Re: Proposal',
        [
          'Just confirming — I will send the signed proposal to Ana by Friday.',
          '',
          'On Tue, 14 Jul 2026, Ana <ana@adriatic-foods.hr> wrote:',
          '> Thanks, looking forward to it.',
        ].join('\n'),
      ),
      { mailFrom: 'ana@adriatic-foods.hr', rcptTo: INBOUND },
    );
    expect(second.accepted).toBe(true);
    await runWorker();
    await runWorker();

    // Reconciliation merged the duplicate: exactly ONE active memory for the
    // fact, and history is preserved (the earlier one is `replaced`, not gone).
    const active = await tdb.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM memory WHERE content = $1 AND status = 'active'",
      [FIXED_CLAIM],
    );
    expect(Number(active.rows[0]!.n)).toBe(1);

    const all = await tdb.pool.query<{ status: string; superseded_by: string | null; id: string }>(
      'SELECT id, status, superseded_by FROM memory WHERE content = $1',
      [FIXED_CLAIM],
    );
    expect(all.rows.length).toBe(2); // both emails' facts exist; one superseded the other
    const activeRow = all.rows.find((r) => r.status === 'active')!;
    const replacedRow = all.rows.find((r) => r.status === 'replaced')!;
    expect(replacedRow).toBeDefined();
    expect(replacedRow.superseded_by).toBe(activeRow.id);
  });
});
