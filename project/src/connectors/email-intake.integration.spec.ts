import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { idempotentTask } from '../infrastructure/index';
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
import { createMemoryReconciliation, MemoryFileStore, MemoryObjectStore } from '../memory/index';
import type { MemoryStore, MemoryReconciliation } from '../memory/index';
import { INGESTION_PIPELINE_JOB_TYPE, createIngestionPipeline } from '../ingestion/index';
import type { IngestionPipeline } from '../ingestion/index';
import { UserDirectory } from '../identity/index';
import { EmailAllowlistService } from './email-allowlist.service';
import { EmailIntakeService } from './email-intake.service';
import { UserSettingsService } from './user-settings.service';
import { EmailSourceReader } from './email.source-reader';
import { FileSourceReader } from './file.source-reader';
import { NotesSourceReader } from './notes.source-reader';
import type { MailOptions } from './mail-options';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';
const COLLECTION = 'email-conn-test';
const INBOUND = 'capture@in.localhost';

const owner: Principal = {
  userId: 'user-mail',
  name: 'Mail Owner',
  email: 'owner@instance.test',
  orgId: 'org-mail',
  orgName: 'Org',
  roles: [],
};

// ── A deterministic gateway that turns any extraction input into one fact,
//    passing verify + reconcile (mirrors the files spec). ─────────────────────
interface CandidateFactLike {
  claim: string;
  kind: string;
  entities: { people: string[]; organizations: string[]; projects: string[] };
  condition: null;
  temporal: { valid_from: null; valid_until: null; anchors_resolved: true };
  source_span: string;
}

class ScriptedGateway extends ModelGateway {
  readonly extractInputs: string[] = [];
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
    const isVerify = request.input.startsWith('CLAIM UNDER REVIEW');
    const isReconcile = request.input.startsWith('FACT A:');
    let raw: unknown;
    if (isReconcile) {
      raw = request.system.includes('same_fact')
        ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
        : { verdict: 'compatible', direction: null, reason: 'scripted' };
    } else if (isVerify) {
      raw = { verdict: 'supported', reason: 'scripted' };
    } else {
      this.extractInputs.push(request.input);
      // Derive the claim from SOURCE CONTENT (not the raw input, whose leading
      // metadata labels the extract stage's provenance guard would strip).
      const content = (request.input.split('SOURCE CONTENT:\n')[1] ?? '').trim();
      const claim = content.split('\n').filter(Boolean).pop() ?? 'a durable fact';
      const fact: CandidateFactLike = {
        claim,
        kind: 'commitment',
        entities: { people: [], organizations: [], projects: [] },
        condition: null,
        temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
        source_span: claim.slice(0, 40),
      };
      raw = { facts: [fact] };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

/** Build a raw RFC822 message. */
function rawEmail(opts: {
  from: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}): Buffer {
  const to = opts.to ?? INBOUND;
  const head = [
    `From: ${opts.from}`,
    `To: ${to}`,
    `Subject: ${opts.subject ?? 'Test'}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@cogeto.test>`,
    'Date: Tue, 14 Jul 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
  ];
  const atts = opts.attachments ?? [];
  if (atts.length === 0 && !opts.html) {
    return Buffer.from(
      `${head.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.text ?? ''}\r\n`,
    );
  }
  if (atts.length === 0 && opts.html) {
    return Buffer.from(
      `${head.join('\r\n')}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${opts.html}\r\n`,
    );
  }
  const boundary = `B${Math.random().toString(36).slice(2)}`;
  const parts: string[] = [];
  parts.push(
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.text ?? ''}\r\n`,
  );
  for (const a of atts) {
    const b64 = a.content.toString('base64').replace(/(.{76})/g, '$1\r\n');
    parts.push(
      `--${boundary}\r\nContent-Type: ${a.contentType}; name="${a.filename}"\r\n` +
        `Content-Disposition: attachment; filename="${a.filename}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`,
    );
  }
  return Buffer.from(
    `${head.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
      `${parts.join('')}--${boundary}--\r\n`,
  );
}

describe('email intake + retention + pipeline (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let objects: MemoryObjectStore;
  let fileStore: MemoryFileStore;
  let store: MemoryStore;
  let reconciliation: MemoryReconciliation;
  let allowlist: EmailAllowlistService;
  let directory: UserDirectory;
  let settings: UserSettingsService;
  let intake: EmailIntakeService;

  const options: MailOptions = {
    inboundAddress: INBOUND,
    maxBytes: 25 * 1024 * 1024,
    attachmentsMaxBytes: 25 * 1024 * 1024,
    adminUserEmail: 'admin@instance.test',
    intakeToken: 'test-token',
    // The routing tests predate SPF; keep the self-route open here and exercise
    // the SEC-1 authentication gate + intake cap in their own test with a
    // strict-options intake service.
    requireAuthenticatedSender: false,
    intakeMaxPerSenderPerWindow: 0,
    intakeRateWindowSeconds: 3600,
  };
  const envelope = { mailFrom: null as string | null, rcptTo: INBOUND };

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
    fileStore = new MemoryFileStore(tdb.db);
    allowlist = new EmailAllowlistService(tdb.db);
    directory = new UserDirectory(tdb.db);
    settings = new UserSettingsService(tdb.db);
    await directory.record(owner);
    intake = new EmailIntakeService(
      tdb.db,
      objects,
      fileStore,
      allowlist,
      directory,
      settings,
      options,
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  // ── Harness ────────────────────────────────────────────────────────────────
  const buildPipeline = (gateway: ScriptedGateway): IngestionPipeline =>
    createIngestionPipeline({
      readers: [
        new EmailSourceReader(tdb.db),
        new FileSourceReader(fileStore, objects),
        new NotesSourceReader(tdb.db),
      ],
      gateway,
      store,
      reconciliation,
    });
  const runWorker = (pipeline: IngestionPipeline) =>
    runOnce({
      pgPool: tdb.pool,
      taskList: {
        [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
          tdb.db,
          INGESTION_PIPELINE_JOB_TYPE,
          async (tx, payload) => {
            await pipeline.run(tx, payload);
          },
        ),
      } as TaskList,
    });

  const emailRow = async (id: string) =>
    (
      await tdb.pool.query(
        'SELECT owner_id, scope, from_addr, to_addr, subject, raw_object_key, text_body, html_body, html_object_key, headers_json, has_attachments FROM email_message WHERE id = $1',
        [id],
      )
    ).rows[0];
  const attachmentRows = async (id: string) =>
    (
      await tdb.pool.query(
        'SELECT filename, content_type, file_object_key, processed FROM email_attachment WHERE email_id = $1 ORDER BY filename',
        [id],
      )
    ).rows as {
      filename: string;
      content_type: string;
      file_object_key: string | null;
      processed: boolean;
    }[];
  const emailRowCount = async () =>
    Number((await tdb.pool.query('SELECT count(*)::text AS n FROM email_message')).rows[0].n);
  const refusalCount = async (reason: string) =>
    Number(
      (
        await tdb.pool.query('SELECT count(*)::text AS n FROM email_refusal WHERE reason = $1', [
          reason,
        ])
      ).rows[0].n,
    );
  const pipelineJobCount = async () =>
    Number(
      (
        await tdb.pool.query(
          'SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE task_identifier = $1',
          [INGESTION_PIPELINE_JOB_TYPE],
        )
      ).rows[0].n,
    );
  const memoriesFor = async (sourceType: string, sourceId: string) =>
    (
      await tdb.pool.query(
        'SELECT content, scope FROM memory WHERE source_type = $1 AND source_id = $2',
        [sourceType, sourceId],
      )
    ).rows as { content: string; scope: string }[];
  const objectCount = async () => (await objects.listObjects()).length;
  const allow = (kind: 'address' | 'domain', value: string) =>
    allowlist.addEntry(owner, { kind, value });

  // ── Tests ────────────────────────────────────────────────────────────────

  it('recipient_rejected: mail to a wrong address is refused, stores nothing', async () => {
    await allow('domain', 'adriatic-foods.hr');
    const result = await intake.intake(rawEmail({ from: 'ana@adriatic-foods.hr' }), {
      mailFrom: 'ana@adriatic-foods.hr',
      rcptTo: 'someone-else@in.localhost',
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.status).toBe('bad_recipient');
    expect(await emailRowCount()).toBe(0);
    expect(await refusalCount('wrong_recipient')).toBe(1);
  });

  it('size_capped: an oversize message is refused, stores nothing', async () => {
    const tiny = new EmailIntakeService(
      tdb.db,
      objects,
      fileStore,
      allowlist,
      directory,
      settings,
      {
        ...options,
        maxBytes: 200,
      },
    );
    const big = rawEmail({ from: 'ana@adriatic-foods.hr', text: 'x'.repeat(5000) });
    const result = await tiny.intake(big, { mailFrom: 'ana@adriatic-foods.hr', rcptTo: INBOUND });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.status).toBe('too_large');
    expect(await emailRowCount()).toBe(0);
    expect(await refusalCount('message_too_large')).toBe(1);
  });

  it('allowlist_enforced: allowlisted address + domain accepted; non-allowlisted refused with no trace; empty allowlist refuses all', async () => {
    // Non-allowlisted sender (no entries yet) → refused, nothing stored.
    const before = await pipelineJobCount();
    const objsBefore = await objectCount();
    const refused = await intake.intake(rawEmail({ from: 'stranger@example.net' }), {
      mailFrom: 'stranger@example.net',
      rcptTo: INBOUND,
    });
    expect(refused.accepted).toBe(false);
    expect(await emailRowCount()).toBe(0);
    expect(await pipelineJobCount()).toBe(before);
    expect(await objectCount()).toBe(objsBefore);
    expect(await refusalCount('sender_not_recognized')).toBeGreaterThanOrEqual(1);

    // Allowlisted DOMAIN → accepted.
    await allow('domain', 'adriatic-foods.hr');
    const byDomain = await intake.intake(
      rawEmail({ from: 'ana@adriatic-foods.hr', text: 'hello' }),
      {
        mailFrom: 'ana@adriatic-foods.hr',
        rcptTo: INBOUND,
      },
    );
    expect(byDomain.accepted).toBe(true);

    // Allowlisted ADDRESS (different domain) → accepted.
    await allow('address', 'bob@other.example');
    const byAddress = await intake.intake(
      rawEmail({ from: 'Bob <bob@other.example>', text: 'hi' }),
      {
        mailFrom: 'bob@other.example',
        rcptTo: INBOUND,
      },
    );
    expect(byAddress.accepted).toBe(true);

    expect(await emailRowCount()).toBe(2);
  });

  it('inbound_parse + full_retention: text, HTML-only, and an attachment each parse and are fully retained', async () => {
    await allow('domain', 'adriatic-foods.hr');

    // (a) text message — full retention of headers, text body, raw original.
    const textResult = await intake.intake(
      rawEmail({
        from: 'ana@adriatic-foods.hr',
        subject: 'Deadline',
        text: 'The delivery deadline moved to Friday.',
      }),
      { ...envelope, mailFrom: 'ana@adriatic-foods.hr' },
    );
    expect(textResult.accepted).toBe(true);
    if (!textResult.accepted) return;
    const textRow = await emailRow(textResult.emailIds[0]!);
    expect(textRow.from_addr).toBe('ana@adriatic-foods.hr');
    expect(textRow.text_body).toContain('deadline moved to Friday');
    expect(textRow.headers_json.subject).toContain('Deadline');
    expect(await objects.statObject(textRow.raw_object_key)).not.toBeNull();

    // (b) HTML-only message — HTML retained (sanitised), no text body dropped silently.
    const htmlResult = await intake.intake(
      rawEmail({
        from: 'ana@adriatic-foods.hr',
        subject: 'Rich',
        html: '<p>Please review <b>the offer</b>.</p><script>evil()</script>',
      }),
      { ...envelope, mailFrom: 'ana@adriatic-foods.hr' },
    );
    expect(htmlResult.accepted).toBe(true);
    if (!htmlResult.accepted) return;
    const htmlRow = await emailRow(htmlResult.emailIds[0]!);
    const retainedHtml = (htmlRow.html_body as string | null) ?? '';
    expect(retainedHtml).toContain('the offer');
    expect(retainedHtml.toLowerCase()).not.toContain('<script'); // sanitised
    expect(await objects.statObject(htmlRow.raw_object_key)).not.toBeNull();

    // (c) message with an attachment — the attachment is retained (recorded).
    const withAtt = await intake.intake(
      rawEmail({
        from: 'ana@adriatic-foods.hr',
        subject: 'Doc',
        text: 'See attached.',
        attachments: [
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: makePdf('Report body'),
          },
        ],
      }),
      { ...envelope, mailFrom: 'ana@adriatic-foods.hr' },
    );
    expect(withAtt.accepted).toBe(true);
    if (!withAtt.accepted) return;
    const attRow = await emailRow(withAtt.emailIds[0]!);
    expect(attRow.has_attachments).toBe(true);
    const atts = await attachmentRows(withAtt.emailIds[0]!);
    expect(atts.length).toBe(1);
    expect(atts[0]!.filename).toBe('report.pdf');
  });

  it('attachment_routing: a pdf becomes a linked file source; an unsupported type is recorded, not processed', async () => {
    await allow('domain', 'adriatic-foods.hr');
    const gateway = new ScriptedGateway();
    const pipeline = buildPipeline(gateway);

    const result = await intake.intake(
      rawEmail({
        from: 'ana@adriatic-foods.hr',
        subject: 'Mixed attachments',
        text: 'Ana will send the Atlas proposal on Monday.',
        attachments: [
          {
            filename: 'proposal.pdf',
            contentType: 'application/pdf',
            content: makePdf('Atlas proposal details'),
          },
          { filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('loose notes') },
        ],
      }),
      { ...envelope, mailFrom: 'ana@adriatic-foods.hr' },
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    const atts = await attachmentRows(result.emailIds[0]!);
    const pdf = atts.find((a) => a.filename === 'proposal.pdf')!;
    const txt = atts.find((a) => a.filename === 'notes.txt')!;
    // The pdf is a linked, stored, processed file source.
    expect(pdf.processed).toBe(true);
    expect(pdf.file_object_key).toMatch(/\/file-/);
    expect(await objects.statObject(pdf.file_object_key!)).not.toBeNull();
    // The unsupported txt is recorded but not processed.
    expect(txt.processed).toBe(false);
    expect(txt.file_object_key).toBeNull();

    // Run the pipeline: the email body AND the pdf attachment both derive memories.
    await runWorker(pipeline);
    await runWorker(pipeline);
    expect((await memoriesFor('email', result.emailIds[0]!)).length).toBeGreaterThan(0);
    expect((await memoriesFor('file', pdf.file_object_key!)).length).toBeGreaterThan(0);
  });

  it('intake_transactional: success leaves exactly the source + job + raw object; a failed store leaves nothing and cleans its objects', async () => {
    await allow('domain', 'adriatic-foods.hr');

    // Success invariant.
    const jobsBefore = await pipelineJobCount();
    const ok = await intake.intake(
      rawEmail({ from: 'ana@adriatic-foods.hr', subject: 'Tx', text: 'a durable fact.' }),
      { ...envelope, mailFrom: 'ana@adriatic-foods.hr' },
    );
    expect(ok.accepted).toBe(true);
    if (!ok.accepted) return;
    expect(await pipelineJobCount()).toBe(jobsBefore + 1);
    const okRow = await emailRow(ok.emailIds[0]!);
    expect(await objects.statObject(okRow.raw_object_key)).not.toBeNull();

    // Failure path: a broken file store throws inside the transaction (after the
    // objects were written) → rollback leaves no row/job, and the compensating
    // delete removes every object written for this message.
    let capturedAttachmentKey = '';
    const brokenFiles = {
      record: async (_tx: unknown, row: { objectKey: string }) => {
        capturedAttachmentKey = row.objectKey;
        throw new Error('boom — injected failure inside the intake transaction');
      },
      get: async () => null,
      existsForAdmission: async () => true,
    } as unknown as MemoryFileStore;
    const brokenIntake = new EmailIntakeService(
      tdb.db,
      objects,
      brokenFiles,
      allowlist,
      directory,
      settings,
      options,
    );

    const rowsBefore = await emailRowCount();
    const jobsBefore2 = await pipelineJobCount();
    const objsBefore = await objectCount();
    await expect(
      brokenIntake.intake(
        rawEmail({
          from: 'ana@adriatic-foods.hr',
          subject: 'Ghost',
          text: 'must leave no trace.',
          attachments: [
            { filename: 'ghost.pdf', contentType: 'application/pdf', content: makePdf('ghost') },
          ],
        }),
        { ...envelope, mailFrom: 'ana@adriatic-foods.hr' },
      ),
    ).rejects.toThrow(/boom/);

    expect(capturedAttachmentKey).not.toBe('');
    expect(await objects.statObject(capturedAttachmentKey)).toBeNull(); // orphan cleaned
    expect(await emailRowCount()).toBe(rowsBefore); // no new source
    expect(await pipelineJobCount()).toBe(jobsBefore2); // no new job
    expect(await objectCount()).toBe(objsBefore); // raw + attachment both cleaned
  });

  // ── Sender routing (decision 0031) ─────────────────────────────────────────

  const customer: Principal = {
    userId: 'user-customer',
    name: 'Customer',
    email: 'customer@client.example',
    orgId: 'org-mail',
    orgName: 'Org',
    roles: [],
  };
  const admin: Principal = {
    userId: 'user-admin',
    name: 'Operator Admin',
    email: 'admin@instance.test',
    orgId: 'org-mail',
    orgName: 'Org',
    roles: ['admin'],
  };
  const ownedBy = async (emailId: string) =>
    (
      await tdb.pool.query(
        'SELECT owner_id, scope, authored_by_owner FROM email_message WHERE id = $1',
        [emailId],
      )
    ).rows[0] as { owner_id: string; scope: string; authored_by_owner: boolean | null };

  it('self_sender_routes: the exact dry-run scenario — admin + customer registered, NO configuration, the customer forwards → captured for the customer', async () => {
    await directory.record(admin);
    await directory.record(customer);
    const result = await intake.intake(
      rawEmail({ from: `Customer <${customer.email}>`, text: 'my forwarded note.' }),
      { mailFrom: customer.email, rcptTo: INBOUND },
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.emailIds).toHaveLength(1);
    const stored = await ownedBy(result.emailIds[0]!);
    expect(stored.owner_id).toBe(customer.userId);
    // Self-route = written by the capture user (P6.5, decision 0054): the
    // intake-time routing fact task derivation builds on.
    expect(stored.authored_by_owner).toBe(true);
  });

  it('sender_authentication_gate (SEC-1): a spoofed self-claim is not captured; an SPF-authenticated one is; the intake rate cap bites', async () => {
    await directory.record(customer);
    // A strict instance: require SPF authentication, cap at 2 messages/sender.
    const strict = new EmailIntakeService(
      tdb.db,
      objects,
      fileStore,
      allowlist,
      directory,
      settings,
      {
        ...options,
        requireAuthenticatedSender: true,
        intakeMaxPerSenderPerWindow: 2,
        intakeRateWindowSeconds: 3600,
      },
    );

    // (a) Spoofed From claiming to be the customer, but SPF FAILS → refused,
    //     never stored as the customer (the exact SEC-1 attack).
    const spoof = await strict.intake(
      rawEmail({ from: `Customer <${customer.email}>`, text: 'injected fact.' }),
      { mailFrom: customer.email, rcptTo: INBOUND, spfResult: 'fail' },
    );
    expect(spoof.accepted).toBe(false);
    if (!spoof.accepted) expect(spoof.status).toBe('refused');

    // (b) SPF none (unauthenticated) → the self-route is NOT taken; with no
    //     allowlist match the message is refused, not captured as the customer.
    const unauth = await strict.intake(
      rawEmail({ from: `Customer <${customer.email}>`, text: 'still injected.' }),
      { mailFrom: customer.email, rcptTo: INBOUND, spfResult: 'none' },
    );
    expect(unauth.accepted).toBe(false);

    // (c) SPF pass → authenticated → captured for the customer.
    const good = await strict.intake(
      rawEmail({ from: `Customer <${customer.email}>`, text: 'a real note.' }),
      { mailFrom: customer.email, rcptTo: INBOUND, spfResult: 'pass' },
    );
    expect(good.accepted).toBe(true);
    if (good.accepted) expect((await ownedBy(good.emailIds[0]!)).owner_id).toBe(customer.userId);

    // (d) Rate cap: the sender has now had 1 accepted (c) + the counter also
    //     advanced on (b)'s pass-through; a couple more pass-SPF sends trip the
    //     per-sender cap → rate_limited (mapped to a 451 retry at the edge).
    let sawRateLimited = false;
    for (let i = 0; i < 4; i++) {
      const r = await strict.intake(
        rawEmail({ from: `Customer <${customer.email}>`, text: `burst ${i}` }),
        { mailFrom: customer.email, rcptTo: INBOUND, spfResult: 'pass' },
      );
      if (!r.accepted && r.status === 'rate_limited') sawRateLimited = true;
    }
    expect(sawRateLimited).toBe(true);
  });

  it('admin_excluded: mail from the operator admin account is refused, never captured', async () => {
    await directory.record(admin);
    const result = await intake.intake(rawEmail({ from: admin.email!, text: 'operator noise.' }), {
      mailFrom: admin.email,
      rcptTo: INBOUND,
    });
    expect(result.accepted).toBe(false);
    expect(await refusalCount('sender_not_recognized')).toBeGreaterThanOrEqual(1);
  });

  it('copy_to_each: an external sender on two users allowlists produces one copy per user; a single-list sender reaches only that user', async () => {
    await directory.record(customer);
    // Both the original owner and the customer allowlist the same client.
    await allowlist.addEntry(owner, { kind: 'address', value: 'client@x.example' });
    await allowlist.addEntry(customer, { kind: 'address', value: 'client@x.example' });
    const both = await intake.intake(
      rawEmail({ from: 'client@x.example', text: 'for both of you.' }),
      { mailFrom: 'client@x.example', rcptTo: INBOUND },
    );
    expect(both.accepted).toBe(true);
    if (!both.accepted) return;
    expect(both.emailIds).toHaveLength(2);
    const owners = await Promise.all(both.emailIds.map(async (id) => (await ownedBy(id)).owner_id));
    expect(owners.sort()).toEqual([customer.userId, owner.userId].sort());

    // Allowlisted for the customer ONLY → exactly one copy, the customer's.
    await allowlist.addEntry(customer, { kind: 'address', value: 'private-client@y.example' });
    const single = await intake.intake(
      rawEmail({ from: 'private-client@y.example', text: 'for one of you.' }),
      { mailFrom: 'private-client@y.example', rcptTo: INBOUND },
    );
    expect(single.accepted).toBe(true);
    if (!single.accepted) return;
    expect(single.emailIds).toHaveLength(1);
    const singleStored = await ownedBy(single.emailIds[0]!);
    expect(singleStored.owner_id).toBe(customer.userId);
    // Allowlist-route = someone else's words (P6.5, decision 0054): these
    // copies must never read as authored by their capture user.
    expect(singleStored.authored_by_owner).toBe(false);
  });

  it('default_scope_respected: a user whose default capture scope is shared captures email as shared', async () => {
    await directory.record(customer);
    await settings.update(customer, { defaultScope: 'shared' });
    const result = await intake.intake(
      rawEmail({ from: customer.email!, text: 'a team-visible note.' }),
      { mailFrom: customer.email, rcptTo: INBOUND },
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect((await ownedBy(result.emailIds[0]!)).scope).toBe('shared');
    await settings.update(customer, { defaultScope: 'private' });
  });
});
