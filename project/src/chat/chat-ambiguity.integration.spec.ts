import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AmbiguityDecisionDto, ChatStreamEvent, Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { UserDirectory } from '../identity/index';
import { ModelGateway } from '../model-gateway/index';
import type { StreamDelta } from '../model-gateway/index';
import type { RetrievalService, RetrieveOptions } from '../retrieval/index';
import { NOTHING_ON_RECORD } from './answer-prompt';
import { chatMessage } from './persistence/tables';
import { ChatService } from './chat.service';

/**
 * The three spec §7.5 behaviours end to end through the chat orchestrator
 * (V2.3 item 6.3, issue B): a fan-out is server-authored with real citations
 * and never calls the model; the silent corpus states itself before marked
 * general knowledge with the sub-floor facts withheld; the dominant branch is
 * untouched; the decision is stored on the row and a fan-out's follow-up
 * resolves through the stored offer without re-fanning.
 */

const owner: Principal = {
  userId: 'user-ambiguity',
  name: 'Owner',
  email: 'a@instance.test',
  orgId: 'org-a',
  orgName: 'Org',
  roles: [],
};

const MEM_A = '44444444-4444-4444-8444-444444444444';
const MEM_B = '55555555-5555-4555-8555-555555555555';

class ScriptedGateway extends ModelGateway {
  structured: unknown[] = [];
  streamText = '';
  streamCalls: string[] = [];
  complete(): never {
    throw new Error('no completion expected');
  }
  async *completeStream(request: { input: string }): AsyncIterable<StreamDelta> {
    this.streamCalls.push(request.input);
    yield { channel: 'text', text: this.streamText } as const;
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

const memoryRow = (id: string, subject: string, content: string) => ({
  id,
  ownerId: owner.userId,
  scope: 'private',
  sourceType: 'file',
  sourceId: `src-${subject}`,
  status: 'active',
  uncertaintyReason: null,
  sensitive: false,
  entities: [subject],
  temporalUnresolved: [],
  subjectEntity: subject,
  kind: 'fact',
  authoredByUser: null,
  validFrom: null,
  validUntil: null,
  supersededBy: null,
  content,
  contentEmbeddingRef: null,
  embeddingModel: 'test-embed',
  createdAt: new Date(),
  updatedAt: new Date(),
});

const fanoutDecision = (): AmbiguityDecisionDto => ({
  branch: 'fan_out',
  clusters: [
    {
      subject: 'VX-9',
      key: 'vx-9',
      relevance: 0.8,
      entityNamed: false,
      fused: 0.03,
      size: 1,
      topMemoryId: MEM_A,
      shown: true,
    },
    {
      subject: 'SEN-210',
      key: 'sen-210',
      relevance: 0.78,
      entityNamed: false,
      fused: 0.028,
      size: 1,
      topMemoryId: MEM_B,
      shown: true,
    },
  ],
  named: [],
  capped: false,
  configVersion: 1,
  embeddingModel: 'test-embed',
});

const rewriteOf = (query: string, extra: Record<string, unknown> = {}) => ({
  rewritten_query: query,
  entities: [],
  temporal: null,
  open_loops: null,
  question_class: null,
  ...extra,
});

const collect = async (events: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> => {
  const all: ChatStreamEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
};

const doneOf = (events: ChatStreamEvent[]) => {
  const done = events.find((e) => e.type === 'done');
  if (!done || done.type !== 'done') throw new Error('no done event');
  return done;
};

describe('chat ambiguity behaviours (integration: real Postgres, scripted seams)', () => {
  let tdb: TestDatabase;
  let gateway: ScriptedGateway;
  let chat: ChatService;
  let conversationId: string;
  /** What the next retrieve() returns, and what it was asked. */
  let nextResult: Record<string, unknown>;
  let lastRetrieveOpts: RetrieveOptions | undefined;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    gateway = new ScriptedGateway();
    nextResult = { memories: [], mode: 'default' };
    const retrieval = {
      retrieve: async (_p: Principal, _q: string, opts: RetrieveOptions) => {
        lastRetrieveOpts = opts;
        return nextResult;
      },
    } as unknown as RetrievalService;
    chat = new ChatService(tdb.db, retrieval, gateway, new UserDirectory(tdb.db), {});
    conversationId = (await chat.createConversation(owner)).id;
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  const storedAmbiguity = async (messageId: string) => {
    const rows = await tdb.db
      .select({ ambiguity: chatMessage.ambiguity })
      .from(chatMessage)
      .where(eq(chatMessage.id, messageId));
    return rows[0]?.ambiguity ?? null;
  };

  it('fan_out: one line per subject with its fact and real citation, capped question, NO model call', async () => {
    gateway.structured = [rewriteOf('What is the fastening torque?')];
    nextResult = {
      memories: [
        {
          memory: memoryRow(MEM_A, 'VX-9', 'The VX-9 fastening torque is 3.2 mm.'),
          score: 0.03,
          signals: ['vector'],
          vectorScore: 0.8,
        },
        {
          memory: memoryRow(MEM_B, 'SEN-210', 'The SEN-210 fastening torque is 3.4 mm.'),
          score: 0.028,
          signals: ['vector'],
          vectorScore: 0.78,
        },
      ],
      mode: 'default',
      ambiguity: fanoutDecision(),
    };
    const beforeStreams = gateway.streamCalls.length;
    const events = await collect(chat.ask(owner, 'What is the fastening torque?', conversationId));
    const done = doneOf(events);

    // Never a model call: the fan-out is server-authored.
    expect(gateway.streamCalls).toHaveLength(beforeStreams);
    // One line per subject, best fact verbatim, REAL canonical citation.
    expect(done.content).toContain(
      `**VX-9**: The VX-9 fastening torque is 3.2 mm. {{cite:${MEM_A}}}`,
    );
    expect(done.content).toContain(
      `**SEN-210**: The SEN-210 fastening torque is 3.4 mm. {{cite:${MEM_B}}}`,
    );
    // Ends by asking which was meant — with content, never a bare question.
    expect(done.content.trimEnd().endsWith('Which did you mean?')).toBe(true);
    expect(done.citationViolations).toBe(0);
    // The decision rides the done event AND the stored row.
    expect(done.ambiguity?.branch).toBe('fan_out');
    expect((await storedAmbiguity(done.messageId))?.branch).toBe('fan_out');
    // The sources frame carries exactly the shown facts, in cluster order.
    const sources = events.find((e) => e.type === 'sources');
    expect(
      sources && sources.type === 'sources' ? sources.facts.map((f) => f.memoryId) : [],
    ).toEqual([MEM_A, MEM_B]);
  });

  it('follow-up: a reply naming an offered subject resolves through the stored fan-out, no re-fan', async () => {
    // The previous turn stored a fan_out; the user answers "the VX-9".
    gateway.structured = [rewriteOf('the VX-9')];
    nextResult = {
      memories: [
        {
          memory: memoryRow(MEM_A, 'VX-9', 'The VX-9 fastening torque is 3.2 mm.'),
          score: 0.03,
          signals: ['vector', 'entity'],
          vectorScore: 0.8,
        },
      ],
      mode: 'default',
      ambiguity: {
        ...fanoutDecision(),
        branch: 'dominant',
        named: ['vx-9'],
      },
    };
    gateway.streamText = 'The VX-9 fastening torque is 3.2 mm [F1].';
    const events = await collect(chat.ask(owner, 'the VX-9', conversationId));
    const done = doneOf(events);

    // The deterministic resolver fed the offered subject into retrieval as a
    // query entity, which is what makes rule 1 fire there.
    expect(lastRetrieveOpts?.rewrite?.entities).toContain('VX-9');
    expect(lastRetrieveOpts?.ambiguity).toBe(true);
    expect(done.ambiguity?.branch).toBe('dominant');
    expect(done.content).toContain(`{{cite:${MEM_A}}}`);
    expect(done.content).not.toContain('Which did you mean?');
  });

  it('silent + personal: the deterministic honesty path, now over sub-floor noise too', async () => {
    gateway.structured = [rewriteOf('What is the launch date for Neptune?')];
    nextResult = {
      memories: [
        {
          memory: memoryRow(MEM_A, 'VX-9', 'The VX-9 fastening torque is 3.2 mm.'),
          score: 0.005,
          signals: ['fts'],
          vectorScore: 0.31,
        },
      ],
      mode: 'default',
      ambiguity: {
        ...fanoutDecision(),
        branch: 'silent',
        clusters: fanoutDecision().clusters.map((c) => ({ ...c, shown: false, relevance: 0.31 })),
      },
    };
    const beforeStreams = gateway.streamCalls.length;
    const events = await collect(
      chat.ask(owner, 'What is the launch date for Neptune?', conversationId),
    );
    const done = doneOf(events);

    expect(gateway.streamCalls).toHaveLength(beforeStreams); // no model call
    expect(done.content).toBe(NOTHING_ON_RECORD);
    expect(done.ambiguity?.branch).toBe('silent');
    // Claiming silence while presenting sources would be incoherent.
    const sources = events.find((e) => e.type === 'sources');
    expect(sources && sources.type === 'sources' ? sources.facts : null).toEqual([]);
  });

  it('silent + knowledge: states the sources hold nothing, THEN marked general knowledge with facts withheld', async () => {
    gateway.structured = [rewriteOf('What does ISO 2768 cover?', { question_class: 'knowledge' })];
    gateway.streamText = 'ISO 2768 defines general tolerances [U].';
    nextResult = {
      memories: [
        {
          memory: memoryRow(MEM_A, 'VX-9', 'The VX-9 fastening torque is 3.2 mm.'),
          score: 0.004,
          signals: ['fts'],
          vectorScore: 0.28,
        },
      ],
      mode: 'default',
      ambiguity: {
        ...fanoutDecision(),
        branch: 'silent',
        clusters: fanoutDecision().clusters.map((c) => ({ ...c, shown: false, relevance: 0.28 })),
      },
    };
    const events = await collect(chat.ask(owner, 'What does ISO 2768 cover?', conversationId));
    const done = doneOf(events);

    // The preamble states silence BEFORE the knowledge, in one stored answer.
    expect(done.content).toMatch(/^I have nothing about this in your sources\./);
    expect(done.content).toContain('{{unsourced}}');
    expect(done.content).not.toContain('{{cite:');
    // The sub-floor facts were withheld: the model cannot cite the disclaimed.
    expect(gateway.streamCalls.at(-1)).toContain('(none)');
    expect(gateway.streamCalls.at(-1)).not.toContain('fastening torque');
    expect(done.ambiguity?.branch).toBe('silent');
  });

  it('dominant: the ordinary answer path is untouched, facts and prompt exactly as before', async () => {
    gateway.structured = [rewriteOf('What is the VX-9 fastening torque?', { entities: ['VX-9'] })];
    gateway.streamText = 'The VX-9 fastening torque is 3.2 mm [F1].';
    nextResult = {
      memories: [
        {
          memory: memoryRow(MEM_A, 'VX-9', 'The VX-9 fastening torque is 3.2 mm.'),
          score: 0.03,
          signals: ['vector', 'entity'],
          vectorScore: 0.8,
        },
      ],
      mode: 'default',
      ambiguity: { ...fanoutDecision(), branch: 'dominant', named: ['vx-9'] },
    };
    const events = await collect(
      chat.ask(owner, 'What is the VX-9 fastening torque?', conversationId),
    );
    const done = doneOf(events);

    expect(done.content).toBe(`The VX-9 fastening torque is 3.2 mm {{cite:${MEM_A}}}.`);
    // The prompt input carries the facts block exactly as the pre-6.3 shape:
    // no ambiguity artifacts anywhere near the model.
    const input = gateway.streamCalls.at(-1)!;
    expect(input).toContain('[F1] The VX-9 fastening torque is 3.2 mm.');
    expect(input).not.toMatch(/cluster|fan.?out|Which did you mean/i);
    expect(done.ambiguity?.branch).toBe('dominant');
  });
});
