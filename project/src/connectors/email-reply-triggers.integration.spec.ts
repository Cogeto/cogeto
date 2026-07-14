import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import {
  fakeEmbedding,
  makePdf,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { ModelGateway } from '../model-gateway/index';
import type { CompletionResult, StructuredExtractionRequest } from '../model-gateway/index';
import { createMemoryStore, MemoryFileStore, MemoryObjectStore } from '../memory/index';
import type { MemoryStore } from '../memory/index';
import { RetrievalService } from '../retrieval/index';
import { ActionRegistry, ApprovalService } from '../agents/index';
import { UserDirectory } from '../identity/index';
import { EmailAllowlistService } from './email-allowlist.service';
import { EmailIntakeService } from './email-intake.service';
import { EmailReplyDraftService } from './email-reply-draft.service';
import { EmailSourceService } from './email-source.service';

const DIMS = 8;
const INBOUND = 'capture@in.localhost';
const owner: Principal = {
  userId: 'user-mail',
  name: 'Owner',
  email: 'owner@instance.test',
  orgId: 'org-mail',
  orgName: 'Org',
  roles: [],
};

/** Answers with a fixed draft body; the rewriter gets a trivial rewrite. */
class ScriptedGateway extends ModelGateway {
  async complete(): Promise<CompletionResult> {
    return { text: 'Thanks — Friday works for the delivery. Best regards.' };
  }
  // eslint-disable-next-line require-yield -- unused
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unused');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(
    _schema: ZodType<T>,
    _request: StructuredExtractionRequest,
  ): Promise<T> {
    return { rewritten_query: 'q', entities: [], temporal: null, open_loops: null } as T;
  }
}

function rawEmail(opts: {
  from: string;
  subject: string;
  text: string;
  attachPdf?: Buffer;
}): Buffer {
  const head = [
    `From: ${opts.from}`,
    `To: ${INBOUND}`,
    `Subject: ${opts.subject}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@cogeto.test>`,
    'Date: Tue, 14 Jul 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
  ];
  if (!opts.attachPdf) {
    return Buffer.from(
      `${head.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.text}\r\n`,
    );
  }
  const b = 'B1';
  const b64 = opts.attachPdf.toString('base64').replace(/(.{76})/g, '$1\r\n');
  return Buffer.from(
    `${head.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n` +
      `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.text}\r\n` +
      `--${b}\r\nContent-Type: application/pdf; name="doc.pdf"\r\n` +
      `Content-Disposition: attachment; filename="doc.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n` +
      `--${b}--\r\n`,
  );
}

const FORWARD_BODY = [
  'FYI — passing this along.',
  '',
  '---------- Forwarded message ---------',
  'From: Ana Kovač <ana@adriatic-foods.hr>',
  'Date: Tue, 7 Jul 2026',
  'Subject: Delivery schedule',
  'To: owner@instance.test',
  '',
  'We will deliver the pallets on Friday.',
].join('\n');

describe('email reply triggers (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let objects: MemoryObjectStore;
  let store: MemoryStore;
  let intake: EmailIntakeService;
  let drafts: EmailReplyDraftService;
  let sources: EmailSourceService;
  let approvals: ApprovalService;

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
    store = createMemoryStore({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: 'test-embed',
        dimensions: DIMS,
        collection: 'reply-triggers',
      },
    });
    await store.ensureIndexReady();
    const gateway = new ScriptedGateway();
    const allowlist = new EmailAllowlistService(tdb.db);
    const directory = new UserDirectory(tdb.db);
    await directory.record(owner);
    // The forwarder (owner) and the direct sender both need to be accepted.
    await allowlist.addEntry(owner, { kind: 'domain', value: 'instance.test' });
    await allowlist.addEntry(owner, { kind: 'domain', value: 'adriatic-foods.hr' });
    intake = new EmailIntakeService(
      tdb.db,
      objects,
      new MemoryFileStore(tdb.db),
      allowlist,
      directory,
      {
        inboundAddress: INBOUND,
        maxBytes: 25 * 1024 * 1024,
        attachmentsMaxBytes: 25 * 1024 * 1024,
        captureUserEmail: owner.email,
        intakeToken: 't',
      },
    );
    approvals = new ApprovalService(tdb.db, new ActionRegistry(store));
    drafts = new EmailReplyDraftService(
      tdb.db,
      new RetrievalService(store, gateway),
      gateway,
      approvals,
    );
    sources = new EmailSourceService(tdb.db, objects);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  const intakeFrom = async (from: string, subject: string, text: string, attachPdf?: Buffer) => {
    const result = await intake.intake(rawEmail({ from, subject, text, attachPdf }), {
      mailFrom: from,
      rcptTo: INBOUND,
    });
    if (!result.accepted) throw new Error(`intake refused: ${result.reason}`);
    return result.emailId;
  };
  const approvalCount = async () =>
    Number((await tdb.pool.query('SELECT count(*)::text AS n FROM approval')).rows[0].n);

  it('forwarded_reply_addressing + reply_button_creates_draft: a forwarded email drafts to the recovered original correspondent; exactly one approval', async () => {
    // A self-forward: the message From is the owner; Ana is in the forwarded body.
    const emailId = await intakeFrom(owner.email, 'Fwd: Delivery schedule', FORWARD_BODY);

    const before = await approvalCount();
    const { approval, to, recipientResolved } = await drafts.draftReply(owner, emailId);
    expect(to).toBe('ana@adriatic-foods.hr'); // recovered original, NOT the forwarder
    expect(recipientResolved).toBe(true);
    expect(await approvalCount()).toBe(before + 1); // exactly one draft

    const draft = await approvals.getEmailDraft(owner, approval.id);
    expect(draft.to).toBe('ana@adriatic-foods.hr');
    expect(draft.subject).toBe('Re: Delivery schedule');
    expect(draft.sent).toBe(false);
    expect(draft.body).toContain('Friday works');
  });

  it('forwarded_reply_addressing: a directly-received email drafts to its actual From', async () => {
    const emailId = await intakeFrom('ana@adriatic-foods.hr', 'Proposal', 'Here is the proposal.');
    const { to, recipientResolved } = await drafts.draftReply(owner, emailId);
    expect(to).toBe('ana@adriatic-foods.hr');
    expect(recipientResolved).toBe(true);
  });

  it('reading_view_faithful: the drawer view renders a normal email with sender/subject/body/attachment', async () => {
    const emailId = await intakeFrom(
      'ana@adriatic-foods.hr',
      'Contract',
      'Please sign the attached contract.',
      makePdf('the contract text'),
    );
    const view = await sources.getSourceForOwner(owner, emailId);
    expect(view).not.toBeNull();
    expect(view!.from).toBe('ana@adriatic-foods.hr');
    expect(view!.to).toBe(INBOUND);
    expect(view!.subject).toBe('Contract');
    expect(view!.textBody).toContain('sign the attached contract');
    expect(view!.attachments.length).toBe(1);
    expect(view!.attachments[0]!.downloadable).toBe(true);
    expect(view!.isForward).toBe(false);
  });

  it('reading_view_faithful: a forwarded email shows the recovered original correspondent', async () => {
    const emailId = await intakeFrom(owner.email, 'Fwd: Delivery schedule', FORWARD_BODY);
    const view = await sources.getSourceForOwner(owner, emailId);
    expect(view!.isForward).toBe(true);
    expect(view!.originalCorrespondent).toContain('ana@adriatic-foods.hr');
    expect(view!.replyRecipientResolved).toBe(true);
  });

  it('owner-only: another user cannot read the email reading view', async () => {
    const emailId = await intakeFrom('ana@adriatic-foods.hr', 'Private', 'secret');
    const other: Principal = { ...owner, userId: 'user-other' };
    expect(await sources.getSourceForOwner(other, emailId)).toBeNull();
  });
});
