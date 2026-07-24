import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryStore } from '../memory/index';
import { UserDirectory } from '../identity/index';
import { EmailSourceReader } from './email.source-reader';
import { EmailAuthorshipBackfill } from './email-authorship-backfill';
import { emailMessage } from './persistence/tables';

/**
 * Email authorship for the derivation rule (P6.5; decision 0054): the reader
 * combines the intake routing fact with forward/quote detection into the
 * per-source authored_by_user, and the one-shot backfill classifies pre-0030
 * rows structurally.
 */
describe('email authorship flag + backfill (P6.5, decision 0054; real Postgres)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;

  const owner: Principal = {
    userId: 'user-authorship',
    name: 'Mail Owner',
    email: 'owner@instance.test',
    orgId: 'org-authorship',
    orgName: 'Org',
    roles: [],
  };

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: 'test-embed',
        dimensions: 8,
        collection: 'authorship-spec',
      },
    });
    await store.ensureIndexReady();
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const insertEmail = async (values: {
    fromAddr: string;
    textBody: string;
    authoredByOwner?: boolean | null;
  }): Promise<string> => {
    const [row] = await tdb.db
      .insert(emailMessage)
      .values({
        ownerId: owner.userId,
        fromAddr: values.fromAddr,
        toAddr: 'capture@in.localhost',
        subject: 'Annex',
        rawObjectKey: `raw-${randomUUID()}`,
        textBody: values.textBody,
        authoredByOwner: values.authoredByOwner ?? null,
      })
      .returning({ id: emailMessage.id });
    return row!.id;
  };

  it('email_authorship_flag: the reader computes authored_by_user from routing + body shape', async () => {
    const reader = new EmailSourceReader(tdb.db);

    // The user's own plain reply (self-routed, no forward): first-person.
    const own = await insertEmail({
      fromAddr: owner.email!,
      textBody: "I'll send the signed annex by Thursday.",
      authoredByOwner: true,
    });
    expect((await reader.load(own))?.authoredByUser).toBe(true);

    // A self-forwarded original: the extracted content is Ana's words.
    const forwarded = await insertEmail({
      fromAddr: owner.email!,
      textBody:
        'FYI\n\n---------- Forwarded message ----------\nFrom: Ana Kovač <ana@adriatic-foods.hr>\nSubject: Annex\n\nI will send the signed annex by Friday.',
      authoredByOwner: true,
    });
    expect((await reader.load(forwarded))?.authoredByUser).toBe(false);

    // An inbound allowlisted sender: their words, never the user's.
    const inbound = await insertEmail({
      fromAddr: 'marko@adriatic-foods.hr',
      textBody: "I'll prepare the export report by Monday.",
      authoredByOwner: false,
    });
    expect((await reader.load(inbound))?.authoredByUser).toBe(false);

    // A pre-0030 row (NULL routing fact): authorship unknown — no flag.
    const legacy = await insertEmail({
      fromAddr: owner.email!,
      textBody: 'I will confirm the venue.',
      authoredByOwner: null,
    });
    expect((await reader.load(legacy))?.authoredByUser).toBeUndefined();
  });

  it('email_authorship_backfill: pre-0030 rows are classified, memories stamped, cleanup chained', async () => {
    const directory = new UserDirectory(tdb.db);
    await directory.record(owner);

    // Three pre-0030 rows: the owner's own reply, the owner's forward of
    // Ana's message, and an inbound sender's message.
    const ownReply = await insertEmail({
      fromAddr: owner.email!,
      textBody: 'I will send the annex tomorrow.',
      authoredByOwner: null,
    });
    const ownForward = await insertEmail({
      fromAddr: owner.email!,
      textBody:
        'FYI\n\nBegin forwarded message:\nFrom: Ana Kovač <ana@adriatic-foods.hr>\nSubject: Annex\n\nI will send the annex on Friday.',
      authoredByOwner: null,
    });
    const inbound = await insertEmail({
      fromAddr: 'marko@adriatic-foods.hr',
      textBody: 'I will prepare the export.',
      authoredByOwner: null,
    });
    // Each email's derived memory, pre-0030 (no authorship flag).
    const memoryFor = async (sourceId: string) =>
      store.createFromFact(owner, {
        content: `derived from ${sourceId.slice(0, 8)}`,
        scope: 'private',
        sourceType: 'email',
        sourceId,
        kind: 'commitment',
      });
    const ownReplyMemory = await memoryFor(ownReply);
    const ownForwardMemory = await memoryFor(ownForward);
    const inboundMemory = await memoryFor(inbound);

    const backfill = new EmailAuthorshipBackfill(tdb.db, directory, store);
    const report = await backfill.run();
    expect(report.classified).toBeGreaterThanOrEqual(3);
    expect(report.authoredByOwner).toBeGreaterThanOrEqual(2); // both owner-sent rows

    const flags = async (emailId: string) =>
      (
        await tdb.pool.query<{ authored_by_owner: boolean }>(
          'SELECT authored_by_owner FROM email_message WHERE id = $1',
          [emailId],
        )
      ).rows[0]!.authored_by_owner;
    expect(await flags(ownReply)).toBe(true);
    expect(await flags(ownForward)).toBe(true); // routing fact: owner sent it…
    expect(await flags(inbound)).toBe(false);

    // …but the MEMORY verdict folds in the forward detection: only the plain
    // reply's memory reads as user-authored.
    const memoryFlag = async (memoryId: string) =>
      (await store.getManySystem([memoryId]))[0]!.authoredByUser;
    expect(await memoryFlag(ownReplyMemory.id)).toBe(true);
    expect(await memoryFlag(ownForwardMemory.id)).toBe(false);
    expect(await memoryFlag(inboundMemory.id)).toBe(false);

    // The cleanup is chained through the outbox.
    const chained = await tdb.pool.query(
      `SELECT 1 FROM outbox_event WHERE event_type = 'email.authorship_backfilled'`,
    );
    expect(chained.rows.length).toBeGreaterThanOrEqual(1);

    // Idempotent: a re-run finds nothing left to classify.
    const again = await backfill.run();
    expect(again.classified).toBe(0);
    expect(again.memoriesStamped).toBe(0);
  });
});
