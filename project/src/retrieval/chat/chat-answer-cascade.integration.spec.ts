import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DailyCounters } from '../../infrastructure/index';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../../testing/index';
import type { TestDatabase } from '../../testing/index';
import { NotesService, NotesSourceDeletion } from '../../connectors/index';
import { DeletionSaga, MemoryStore, parseReceiptCounts } from '../../memory/index';
import { chatMessage } from '../persistence/tables';
import { CHAT_ANSWER_REDACTED, ChatAnswerCascade } from './chat-answer-cascade';

const userA: Principal = {
  userId: 'chat-cascade-a',
  name: 'A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};

describe('QS-7 chat-answer cascade (integration: real Postgres, real saga)', () => {
  let tdb: TestDatabase;
  let store: MemoryStore;
  let notes: NotesService;
  let saga: DeletionSaga;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    store = new MemoryStore(tdb.db); // rows only — this cascade never touches Qdrant
    notes = new NotesService(tdb.db, new DailyCounters(), {
      captureMax: 1_000_000,
      uploadMax: 1_000_000,
    });
    saga = new DeletionSaga(tdb.db, [new NotesSourceDeletion()], undefined, [
      new ChatAnswerCascade(),
    ]);
  });
  afterAll(async () => {
    await tdb.stop();
  });

  const insertMessage = async (ownerId: string, role: 'user' | 'assistant', content: string) => {
    const [row] = await tdb.db
      .insert(chatMessage)
      .values({ ownerId, role, content })
      .returning({ id: chatMessage.id });
    return row!.id;
  };
  const contentOf = async (id: string): Promise<string> => {
    const { rows } = await tdb.pool.query<{ content: string }>(
      `SELECT content FROM chat_message WHERE id = $1`,
      [id],
    );
    return rows[0]!.content;
  };

  it('chat_answer_cascade: deleting a source redacts every assistant answer citing its memories — historical, cross-owner — and counts them in the receipt', async () => {
    const note = await notes.createNote(userA, 'Novira agreed to a €48,000 Q3 renewal.');
    const m1 = await store.createFromFact(userA, {
      content: 'Novira agreed to a €48,000 Q3 renewal.',
      scope: 'shared', // shared: a peer's answer may legitimately have cited it
      sourceType: 'user_note',
      sourceId: note.id,
    });
    const other = await store.createFromFact(userA, {
      content: 'The workshops run on Teams.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: `note-other-${Date.now()}`,
    });

    // The four shapes the cascade must distinguish:
    const citing = await insertMessage(
      userA.userId,
      'assistant',
      `The renewal is agreed {{cite:${m1.id}}}.`,
    );
    const citingOther = await insertMessage(
      userA.userId,
      'assistant',
      `Workshops run on Teams {{cite:${other.id}}}.`,
    );
    const userTurn = await insertMessage(
      userA.userId,
      'user',
      `I typed {{cite:${m1.id}}} myself — my own words are not the assistant's output.`,
    );
    const peerCiting = await insertMessage(
      'chat-cascade-peer',
      'assistant',
      `Your colleague recorded the renewal {{cite:${m1.id}}}.`,
    );

    const { receiptId } = await saga.requestSourceDeletion(userA, 'user_note', note.id);

    // The two assistant answers citing the erased memory are redacted — the
    // owner's AND the peer's (erasure is erasure); the timeline rows survive.
    expect(await contentOf(citing)).toBe(CHAT_ANSWER_REDACTED);
    expect(await contentOf(peerCiting)).toBe(CHAT_ANSWER_REDACTED);
    // An answer citing a different memory and the user's own words are untouched.
    expect(await contentOf(citingOther)).toContain(other.id);
    expect(await contentOf(userTurn)).toContain(m1.id);

    // The receipt counts the redactions — the erasure claim covers derived
    // conversation content, not just rows/points/bytes.
    const { rows } = await tdb.pool.query<{ counts_json: unknown }>(
      `SELECT counts_json FROM deletion_receipt WHERE id = $1`,
      [receiptId],
    );
    const counts = parseReceiptCounts(rows[0]!.counts_json);
    expect(counts.chat_messages_redacted).toBe(2);
    expect(counts.memory_count).toBe(1);
  });

  it('chat_answer_cascade_idempotent: an already-redacted answer never re-matches or double-counts', async () => {
    const note = await notes.createNote(userA, 'The go-live moved to October 1.');
    const m = await store.createFromFact(userA, {
      content: 'The go-live moved to October 1.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: note.id,
    });
    const answer = await insertMessage(
      userA.userId,
      'assistant',
      `Go-live is October 1 {{cite:${m.id}}}.`,
    );

    const first = await saga.requestSourceDeletion(userA, 'user_note', note.id);
    expect(await contentOf(answer)).toBe(CHAT_ANSWER_REDACTED);
    const firstCounts = parseReceiptCounts(
      (
        await tdb.pool.query<{ counts_json: unknown }>(
          `SELECT counts_json FROM deletion_receipt WHERE id = $1`,
          [first.receiptId],
        )
      ).rows[0]!.counts_json,
    );
    expect(firstCounts.chat_messages_redacted).toBe(1);

    // A second deletion (another source) finds no cite tokens in the marker
    // text: the cascade's matching is on the tokens redaction removed.
    const note2 = await notes.createNote(userA, 'Another source entirely.');
    await store.createFromFact(userA, {
      content: 'Another source entirely.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: note2.id,
    });
    const second = await saga.requestSourceDeletion(userA, 'user_note', note2.id);
    const secondCounts = parseReceiptCounts(
      (
        await tdb.pool.query<{ counts_json: unknown }>(
          `SELECT counts_json FROM deletion_receipt WHERE id = $1`,
          [second.receiptId],
        )
      ).rows[0]!.counts_json,
    );
    expect(secondCounts.chat_messages_redacted).toBe(0);
    expect(await contentOf(answer)).toBe(CHAT_ANSWER_REDACTED);
  });
});
