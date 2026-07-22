import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { startTestDatabase } from '../../testing/index';
import type { TestDatabase } from '../../testing/index';
import { UserDirectory } from '../../identity/index';
import { ModelGateway } from '../../model-gateway/index';
import type { RetrievalService } from '../retrieval.service';
import type { ChatResearchProposal, ChatResearchResolverPort } from './chat-research-resolver.port';
import { ChatService } from './chat.service';

/**
 * The chat research intent (decision 0045): invocation opens the GATE — it
 * proposes, discloses, and points at the Research page; it never searches.
 * `not_ambient`: an ordinary question never touches the research seam.
 */

const owner: Principal = {
  userId: 'user-chat-research',
  name: 'Researcher',
  email: 'r@instance.test',
  orgId: 'org-r',
  orgName: 'Org',
  roles: [],
};

class RecordingResolver implements ChatResearchResolverPort {
  proposals: string[] = [];
  async propose(_principal: Principal, intent: string): Promise<ChatResearchProposal> {
    this.proposals.push(intent);
    return {
      runId: '00000000-0000-4000-8000-000000000001',
      intent,
      minimisedQuery: 'GDPR consent requirements CRM migration',
      minimiseReason: 'client name removed — the intent is general',
    };
  }
}

/** Gateway that fails loudly if the research path ever generates or searches. */
class InertGateway extends ModelGateway {
  structuredCalls = 0;
  complete(): never {
    throw new Error('no completion expected');
  }
  // eslint-disable-next-line require-yield -- ordinary-question path is stubbed to no facts
  async *completeStream(): AsyncIterable<string> {
    throw new Error('no stream expected');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0, 0]);
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(): Promise<T> {
    this.structuredCalls += 1;
    throw new Error('rewrite unavailable'); // rewriter falls back to the raw query
  }
}

const collect = async (events: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> => {
  const all: ChatStreamEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
};

describe('chat research intent (integration: real Postgres, stubbed seams)', () => {
  let tdb: TestDatabase;
  let resolver: RecordingResolver;
  let retrieveCalls: number;
  let chat: ChatService;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    resolver = new RecordingResolver();
    retrieveCalls = 0;
    const retrieval = {
      retrieve: async () => {
        retrieveCalls += 1;
        return { memories: [], mode: 'default' };
      },
    } as unknown as RetrievalService;
    chat = new ChatService(
      tdb.db,
      retrieval,
      new InertGateway(),
      new UserDirectory(tdb.db),
      undefined,
      resolver,
    );
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  it('research_intent_gated: invocation proposes and discloses — it never searches first', async () => {
    const events = await collect(chat.ask(owner, 'research GDPR consent for Adriatic Foods'));
    expect(resolver.proposals).toEqual(['GDPR consent for Adriatic Foods']);
    // The gate reply: deterministic, discloses the minimised query + reason,
    // states nothing has been sent, and points at the Research page.
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' ? done.content : '').toContain('nothing has been sent');
    expect(done && done.type === 'done' ? done.content : '').toContain(
      'GDPR consent requirements CRM migration',
    );
    expect(done && done.type === 'done' ? done.content : '').toContain('Research page');
    // No retrieval, no generation — the turn ended at the gate.
    expect(retrieveCalls).toBe(0);
  });

  it('speaks Croatian when invoked in Croatian', async () => {
    const events = await collect(chat.ask(owner, 'istraži rokove EU AI Acta'));
    expect(resolver.proposals.at(-1)).toBe('rokove EU AI Acta');
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' ? done.content : '').toContain('ništa još nije poslano');
  });

  it('not_ambient: an ordinary question touches retrieval, never the research seam', async () => {
    const before = resolver.proposals.length;
    const events = await collect(chat.ask(owner, 'what did I promise Marko about the invoice?'));
    expect(resolver.proposals).toHaveLength(before); // research untouched
    expect(retrieveCalls).toBeGreaterThan(0); // normal retrieval ran
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeTruthy(); // deterministic nothing-on-record path completed
  });
});
