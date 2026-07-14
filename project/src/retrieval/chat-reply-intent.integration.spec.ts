import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryStore } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import { UserDirectory } from '../identity/index';
import { ChatService } from './chat/chat.service';
import { RetrievalService } from './retrieval.service';
import type {
  ChatReplyCandidate,
  ChatReplyDraftResult,
  ChatReplyResolverPort,
} from './chat/chat-reply-resolver.port';

const DIMS = 8;
const user: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: 'a@instance.test',
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};

/** A gateway that must NOT be asked to answer during a reply-intent turn. */
class NoAnswerGateway extends ModelGateway {
  streamCalls = 0;
  complete(): never {
    throw new Error('reply intent must not call complete');
  }
  extractStructured<T>(): Promise<T> {
    // The rewriter may call this; reply detection is deterministic, so return a
    // trivial rewrite. But the reply path returns BEFORE retrieval, so it won't.
    throw new Error('not expected during a reply-intent turn');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  // eslint-disable-next-line require-yield -- must not be used
  async *completeStream(): AsyncIterable<string> {
    this.streamCalls += 1;
    throw new Error('reply intent must not stream an answer');
  }
}

/** A resolver that records calls and returns scripted candidates. */
class FakeResolver implements ChatReplyResolverPort {
  candidates: ChatReplyCandidate[] = [];
  findCalls: (string | null)[] = [];
  createCalls: string[] = [];
  draft: ChatReplyDraftResult = { approvalId: 'appr-1', recipientResolved: true, to: 'ana@x.hr' };

  async findCandidates(_p: Principal, name: string | null): Promise<ChatReplyCandidate[]> {
    this.findCalls.push(name);
    return this.candidates;
  }
  async createDraft(_p: Principal, emailId: string): Promise<ChatReplyDraftResult> {
    this.createCalls.push(emailId);
    return this.draft;
  }
}

describe('chat reply intent (integration: real Postgres + Qdrant, fake resolver)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let gateway: NoAnswerGateway;
  let resolver: FakeResolver;
  let chat: ChatService;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: 'test-embed',
        dimensions: DIMS,
        collection: 'reply-intent',
      },
    });
    await store.ensureIndexReady();
    gateway = new NoAnswerGateway();
    resolver = new FakeResolver();
    chat = new ChatService(
      tdb.db,
      new RetrievalService(store, gateway),
      gateway,
      new UserDirectory(tdb.db),
      resolver,
    );
  }, 120_000);
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const answerOf = async (question: string): Promise<string> => {
    let text = '';
    for await (const event of chat.ask(user, question) as AsyncGenerator<ChatStreamEvent>) {
      if (event.type === 'token') text += event.text;
    }
    return text;
  };
  const jobCount = async (): Promise<number> =>
    Number(
      (await tdb.pool.query('SELECT count(*)::text AS n FROM graphile_worker.jobs')).rows[0].n,
    );

  it('chat_reply_intent: a confident single match creates exactly one draft and confirms', async () => {
    resolver.candidates = [
      {
        emailId: 'email-1',
        from: 'ana@x.hr',
        subject: 'Proposal',
        receivedAt: new Date(0).toISOString(),
      },
    ];
    resolver.createCalls = [];
    const answer = await answerOf("draft a reply to Ana's last email");
    expect(resolver.findCalls.at(-1)).toBe('Ana');
    expect(resolver.createCalls).toEqual(['email-1']); // exactly one draft
    expect(answer.toLowerCase()).toContain('drafted a reply');
    expect(answer.toLowerCase()).toContain('never sends');
  });

  it('chat_reply_intent: an ambiguous named request lists candidates and creates NOTHING', async () => {
    resolver.candidates = [
      {
        emailId: 'e1',
        from: 'ana@x.hr',
        subject: 'Proposal',
        receivedAt: new Date(0).toISOString(),
      },
      {
        emailId: 'e2',
        from: 'ana@x.hr',
        subject: 'Invoice',
        receivedAt: new Date(0).toISOString(),
      },
    ];
    resolver.createCalls = [];
    const answer = await answerOf('reply to Ana');
    expect(resolver.createCalls).toEqual([]); // asked, did not draft
    expect(answer.toLowerCase()).toContain('which one');
    expect(answer).toContain('Proposal');
    expect(answer).toContain('Invoice');
  });

  it('chat_reply_intent: a no-match request declines cleanly and creates NOTHING', async () => {
    resolver.candidates = [];
    resolver.createCalls = [];
    const answer = await answerOf('reply to Zoltan');
    expect(resolver.createCalls).toEqual([]);
    expect(answer.toLowerCase()).toContain("couldn't find");
    expect(answer).toContain('Draft reply');
  });

  it('fast_path_clean: a reply-intent turn does no ingestion work (no queued jobs) and streams no model answer', async () => {
    resolver.candidates = [
      { emailId: 'email-9', from: 'ana@x.hr', subject: 'X', receivedAt: new Date(0).toISOString() },
    ];
    const before = await jobCount();
    gateway.streamCalls = 0;
    await answerOf('draft a reply to Ana');
    expect(await jobCount()).toBe(before); // no pipeline/ingestion job enqueued
    expect(gateway.streamCalls).toBe(0); // no answer generation
  });

  it('no_send_preserved: the reply path only creates a draft (approval) — it never sends', async () => {
    // The resolver's createDraft returns an approval id and nothing that could
    // send; ChatService only surfaces the confirmation. (The effect handler's
    // no-send guarantee is covered by the agents reply_draft_no_send test.)
    resolver.candidates = [
      { emailId: 'email-x', from: 'ana@x.hr', subject: 'X', receivedAt: new Date(0).toISOString() },
    ];
    resolver.createCalls = [];
    resolver.draft = { approvalId: 'appr-9', recipientResolved: false, to: '' };
    const answer = await answerOf('draft a reply to Ana');
    expect(resolver.createCalls).toEqual(['email-x']);
    // Recipient unresolved → the confirmation asks the user to set it.
    expect(answer.toLowerCase()).toContain('recipient');
    expect(answer.toLowerCase()).toContain('never sends');
  });
});
