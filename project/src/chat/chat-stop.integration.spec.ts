import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { UserDirectory } from '../identity/index';
import { ModelGateway } from '../model-gateway/index';
import type { CompletionRequest, StreamDelta } from '../model-gateway/index';
import type { RetrievalService } from '../retrieval/index';
import { chatMessage } from './persistence/tables';
import { ChatService } from './chat.service';
import { GenerationRegistry } from './generation-registry';

/**
 * Stop (issue #532), through the orchestrator.
 *
 *   stop_keeps_what_was_written — the point: the partial answer is STORED,
 *     by the ordinary path, and flagged.
 *   stop_stores_exactly_once — the race that would otherwise produce two
 *     assistant messages.
 *   stop_during_thinking_stores_nothing — a reasoning model interrupted
 *     before any answer text leaves no empty bubble.
 *   stop_signal_reaches_the_model — Stop ends GENERATION, not merely reading.
 *   normal_completion_unchanged — the flag is false and nothing else moved.
 *   registry_is_owner_scoped — one user cannot stop another's generation.
 */

const owner: Principal = {
  userId: 'user-stop',
  name: 'Owner',
  email: null,
  orgId: 'org-stop',
  orgName: 'Org',
  roles: [],
};
const other: Principal = { ...owner, userId: 'user-other' };

/** Streams deltas until the caller's signal fires, like a real provider. */
class StoppableGateway extends ModelGateway {
  sawSignal: AbortSignal | undefined;
  /** Deltas to emit before pausing for the stop, then after it. */
  before: StreamDelta[] = [{ channel: 'text', text: 'The answer begins' }];
  after: StreamDelta[] = [{ channel: 'text', text: ' and would continue.' }];
  structured: unknown[] = [];
  /** Fires once the stream has emitted `before`, so a test can stop precisely. */
  reached!: Promise<void>;
  private announce!: () => void;

  constructor() {
    super();
    this.reached = new Promise((resolve) => (this.announce = resolve));
  }
  complete(): never {
    throw new Error('unused');
  }
  async *completeStream(request: CompletionRequest): AsyncIterable<StreamDelta> {
    this.sawSignal = request.signal;
    for (const delta of this.before) yield delta;
    this.announce();
    // Give the test a turn to press Stop, then behave as a provider does when
    // the connection is aborted mid-answer.
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (request.signal?.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    for (const delta of this.after) yield delta;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0, 0]);
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(): Promise<T> {
    const next = this.structured.shift();
    if (!next) throw new Error('rewrite unavailable');
    return next as T;
  }
}

const rewriteOf = (query: string) => ({
  rewritten_query: query,
  entities: [],
  temporal: null,
  open_loops: null,
  question_class: null,
});

describe('stop generation (integration: real Postgres, scripted provider)', () => {
  let tdb: TestDatabase;
  let gateway: StoppableGateway;
  let chat: ChatService;
  let registry: GenerationRegistry;

  const build = () => {
    gateway = new StoppableGateway();
    // A fact must come back, or the turn takes the deterministic
    // nothing-on-record path and never reaches the model at all.
    const retrieval = {
      retrieve: async () => ({
        memories: [
          {
            memory: {
              id: '99999999-9999-4999-8999-999999999999',
              ownerId: owner.userId,
              scope: 'private',
              sourceType: 'user_note',
              sourceId: 'note-stop',
              status: 'active',
              uncertaintyReason: null,
              sensitive: false,
              entities: ['Stop'],
              temporalUnresolved: [],
              subjectEntity: 'Stop',
              kind: 'fact',
              authoredByUser: null,
              validFrom: null,
              validUntil: null,
              supersededBy: null,
              content: 'A fact the answer can stand on.',
              contentEmbeddingRef: null,
              embeddingModel: 'test-embed',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            score: 0.03,
            signals: ['vector'],
            vectorScore: 0.9,
          },
        ],
        mode: 'default',
      }),
    } as unknown as RetrievalService;
    chat = new ChatService(tdb.db, retrieval, gateway, new UserDirectory(tdb.db), {});
    registry = new GenerationRegistry();
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await tdb.stop();
  });

  const storedAnswers = async (conversationId: string) =>
    tdb.db
      .select({ id: chatMessage.id, content: chatMessage.content, stopped: chatMessage.stopped })
      .from(chatMessage)
      .where(eq(chatMessage.conversationId, conversationId));

  /** Drives a turn, pressing Stop once the provider has emitted its opening. */
  const askAndStop = async (stopIt: boolean) => {
    build();
    const conversationId = (await chat.createConversation(owner)).id;
    gateway.structured = [rewriteOf('what is the answer?')];
    const generationId = '11111111-1111-4111-8111-111111111111';
    const signal = registry.open(generationId, owner.userId);
    const events: ChatStreamEvent[] = [];
    const run = (async () => {
      for await (const event of chat.ask(owner, 'what is the answer?', conversationId, {
        stopSignal: signal,
      })) {
        events.push(event);
      }
    })();
    if (stopIt) {
      await gateway.reached;
      expect(registry.stop(generationId, owner.userId)).toBe(true);
    }
    await run;
    return { conversationId, events, generationId };
  };

  it('stop_keeps_what_was_written, flagged, and stores it once', async () => {
    const { conversationId, events } = await askAndStop(true);
    const rows = (await storedAnswers(conversationId)).filter(
      (row) => row.content.length > 0 && row.content !== 'what is the answer?',
    );
    // Exactly one assistant row: the double-store race is the likeliest bug.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stopped).toBe(true);
    expect(rows[0]!.content).toContain('The answer begins');
    // And what was NOT generated is genuinely absent.
    expect(rows[0]!.content).not.toContain('would continue');
    const done = events.find((event) => event.type === 'done');
    expect(done && done.type === 'done' && done.stopped).toBe(true);
  });

  it('stop_signal_reaches_the_model: generation ends, not just reading', async () => {
    await askAndStop(true);
    // The seam carried a signal down to the provider call, which is the whole
    // difference between stopping generation and stopping consumption.
    expect(gateway.sawSignal).toBeDefined();
    expect(gateway.sawSignal!.aborted).toBe(true);
  });

  it('normal_completion_unchanged: the flag is false and the answer is whole', async () => {
    const { conversationId, events } = await askAndStop(false);
    const rows = (await storedAnswers(conversationId)).filter(
      (row) => row.content !== 'what is the answer?',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stopped).toBe(false);
    expect(rows[0]!.content).toContain('would continue');
    const done = events.find((event) => event.type === 'done');
    expect(done && done.type === 'done' && done.stopped).toBe(false);
  });

  it('stop_during_thinking_stores_nothing: no empty bubble', async () => {
    build();
    // A reasoning model that has produced only thinking when Stop lands.
    gateway.before = [{ channel: 'thinking', text: 'weighing the options' }];
    gateway.after = [{ channel: 'text', text: 'never reached' }];
    const conversationId = (await chat.createConversation(owner)).id;
    gateway.structured = [rewriteOf('think about it')];
    const generationId = '22222222-2222-4222-8222-222222222222';
    const signal = registry.open(generationId, owner.userId);
    const events: ChatStreamEvent[] = [];
    const run = (async () => {
      for await (const event of chat.ask(owner, 'think about it', conversationId, {
        stopSignal: signal,
      })) {
        events.push(event);
      }
    })();
    await gateway.reached;
    registry.stop(generationId, owner.userId);
    await run;

    const answers = (await storedAnswers(conversationId)).filter(
      (row) => row.content !== 'think about it',
    );
    expect(answers).toEqual([]);
    const done = events.find((event) => event.type === 'done');
    expect(done && done.type === 'done' && done.messageId).toBe('');
  });

  it('registry_is_owner_scoped, idempotent, and honest about losing the race', () => {
    const fresh = new GenerationRegistry();
    const id = '33333333-3333-4333-8333-333333333333';
    fresh.open(id, owner.userId);
    // Another user cannot stop it.
    expect(fresh.stop(id, other.userId)).toBe(false);
    expect(fresh.stop(id, owner.userId)).toBe(true);
    // Stopping twice, or stopping a finished generation, is not an error.
    expect(fresh.stop(id, owner.userId)).toBe(false);
    expect(fresh.stop('44444444-4444-4444-8444-444444444444', owner.userId)).toBe(false);
  });
});
