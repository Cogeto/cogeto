import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { NOTHING_ON_RECORD } from './answer-prompt';
import { startTestDatabase } from '../../testing/index';
import type { TestDatabase } from '../../testing/index';
import { UserDirectory } from '../../identity/index';
import { ModelGateway } from '../../model-gateway/index';
import type { RetrievalService } from '../retrieval.service';
import type { ChatReplyResolverPort } from './chat-reply-resolver.port';
import type { ChatResearchProposal, ChatResearchResolverPort } from './chat-research-resolver.port';
import { ChatService } from './chat.service';

/**
 * The conversational router end to end (decision 0046): small talk answers
 * naturally without retrieval; a knowledge question never silently searches —
 * it answers marked-unsourced with the research OFFER; the reply and research
 * intents carry resolved anaphora across capability boundaries; classification
 * failure falls back to the memory-question path.
 */

const owner: Principal = {
  userId: 'user-chat-conv',
  name: 'Owner',
  email: 'o@instance.test',
  orgId: 'org-c',
  orgName: 'Org',
  roles: [],
};

const MEM_ID = '33333333-3333-4333-8333-333333333333';

/** A scripted gateway: structured results queue + one canned stream. */
class ScriptedGateway extends ModelGateway {
  structured: unknown[] = [];
  structuredCalls: string[] = [];
  streamText = '';
  streamCalls: string[] = [];
  complete(): never {
    throw new Error('no completion expected');
  }
  async *completeStream(request: { input: string }): AsyncIterable<string> {
    this.streamCalls.push(request.input);
    yield this.streamText;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0, 0]);
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(_schema: unknown, request: { input: string }): Promise<T> {
    this.structuredCalls.push(request.input);
    const next = this.structured.shift();
    if (!next) throw new Error('rewrite unavailable');
    return next as T;
  }
}

class RecordingResearchResolver implements ChatResearchResolverPort {
  proposals: string[] = [];
  async propose(_principal: Principal, intent: string): Promise<ChatResearchProposal> {
    this.proposals.push(intent);
    return {
      runId: '00000000-0000-4000-8000-000000000002',
      intent,
      minimisedQuery: intent,
      minimiseReason: 'kept — researching the subject is the point',
    };
  }
}

class RecordingReplyResolver implements ChatReplyResolverPort {
  targets: Array<string | null> = [];
  async findCandidates(_principal: Principal, target: string | null) {
    this.targets.push(target);
    return [];
  }
  async createDraft(): Promise<never> {
    throw new Error('no draft expected — findCandidates returns none');
  }
}

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

describe('chat conversational routing (integration: real Postgres, scripted seams)', () => {
  let tdb: TestDatabase;
  let gateway: ScriptedGateway;
  let research: RecordingResearchResolver;
  let reply: RecordingReplyResolver;
  let retrieveCalls: number;
  let nextMemories: unknown[];
  let chat: ChatService;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    gateway = new ScriptedGateway();
    research = new RecordingResearchResolver();
    reply = new RecordingReplyResolver();
    retrieveCalls = 0;
    nextMemories = [];
    const retrieval = {
      retrieve: async () => {
        retrieveCalls += 1;
        return { memories: nextMemories, mode: 'default' };
      },
    } as unknown as RetrievalService;
    chat = new ChatService(tdb.db, retrieval, gateway, new UserDirectory(tdb.db), reply, research);
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  it('smalltalk_natural: "thanks!" gets a natural reply — no retrieval, no model call, no citations', async () => {
    const before = { retrieve: retrieveCalls, streams: gateway.streamCalls.length };
    const events = await collect(chat.ask(owner, 'thanks!'));
    const done = doneOf(events);

    expect(retrieveCalls).toBe(before.retrieve); // no retrieval theatre
    expect(gateway.streamCalls).toHaveLength(before.streams); // no model call
    expect(done.content).not.toContain(NOTHING_ON_RECORD);
    expect(done.content).not.toMatch(/\{\{/); // no citation tokens
    expect(done.content.length).toBeGreaterThan(0);
    expect(done.citationViolations).toBe(0);
    const sources = events.find((e) => e.type === 'sources');
    expect(sources && sources.type === 'sources' ? sources.facts : null).toEqual([]);
  });

  it('smalltalk_natural (hr): "hvala!" answers in Croatian', async () => {
    const events = await collect(chat.ask(owner, 'hvala!'));
    expect(doneOf(events).content).toContain('Nema na čemu');
  });

  it('meta questions route through the model classifier to a natural answer-tier reply', async () => {
    gateway.structured = [rewriteOf('What can Cogeto help with?', { question_class: 'smalltalk' })];
    gateway.streamText = 'I keep track of what you capture and answer with sources.';
    const before = retrieveCalls;
    const events = await collect(chat.ask(owner, 'so what exactly can you do for me?'));
    const done = doneOf(events);

    expect(retrieveCalls).toBe(before); // still no retrieval
    expect(gateway.streamCalls.at(-1)).toContain('MODE: smalltalk');
    expect(done.content).toContain('keep track');
  });

  it('research_never_silent: a knowledge question answers marked-unsourced and OFFERS research — the seam is never touched', async () => {
    gateway.structured = [
      rewriteOf('What does GDPR Article 17 require?', { question_class: 'knowledge' }),
    ];
    gateway.streamText =
      'Article 17 grants the right to erasure [U]. Controllers must respond without undue delay [U].';
    const beforeProposals = research.proposals.length;
    nextMemories = [];

    const events = await collect(chat.ask(owner, 'What does GDPR Article 17 require?'));
    const done = doneOf(events);

    // Never a silent search: the research seam is untouched; the OFFER is the bridge.
    expect(research.proposals).toHaveLength(beforeProposals);
    expect(done.researchOffer).toEqual({ topic: 'What does GDPR Article 17 require?' });
    // The answer is the model's knowledge, visibly marked; no fabricated cites.
    expect(done.content).toContain('{{unsourced}}');
    expect(done.content).not.toMatch(/\{\{cite:/);
    // The knowledge path told the prompt so.
    expect(gateway.streamCalls.at(-1)).toContain('GENERAL KNOWLEDGE: allowed');
  });

  it('memory-first: a personal question with no facts stays nothing-on-record, no offer, no model call', async () => {
    gateway.structured = [
      rewriteOf('What is our office door code?', { question_class: 'personal' }),
    ];
    const beforeStreams = gateway.streamCalls.length;
    nextMemories = [];
    const events = await collect(chat.ask(owner, 'What is our office door code?'));
    const done = doneOf(events);

    expect(done.content).toBe(NOTHING_ON_RECORD);
    expect(done.researchOffer ?? null).toBeNull();
    expect(gateway.streamCalls).toHaveLength(beforeStreams);
  });

  it('classification failure falls back to the memory-question path', async () => {
    gateway.structured = []; // extractStructured throws → fallback
    nextMemories = [];
    const events = await collect(chat.ask(owner, 'What does the EU AI Act say about logging?'));
    expect(doneOf(events).content).toBe(NOTHING_ON_RECORD);
  });

  it('blended answers keep memory cites alongside marked unsourced claims', async () => {
    gateway.structured = [
      rewriteOf('What CRM does Adriatic Foods use, and what is HubSpot known for?', {
        question_class: 'knowledge',
        entities: ['Adriatic Foods'],
      }),
    ];
    gateway.streamText = 'Adriatic Foods uses HubSpot [F1]. HubSpot is known for inbound CRM [U].';
    nextMemories = [
      {
        memory: {
          id: MEM_ID,
          content: 'Adriatic Foods uses HubSpot CRM',
          status: 'active',
          scope: 'private',
          ownerId: owner.userId,
          sensitive: false,
          subjectEntity: 'Adriatic Foods',
          sourceType: 'user_note',
          sourceId: 'note-1',
          validFrom: null,
          validUntil: null,
          supersededBy: null,
        },
        score: 1,
        signals: ['entity'],
      },
    ];
    const events = await collect(
      chat.ask(owner, 'What CRM does Adriatic Foods use, and what is HubSpot known for?'),
    );
    const done = doneOf(events);
    expect(done.content).toContain(`{{cite:${MEM_ID}}}`);
    expect(done.content).toContain('{{unsourced}}');
    expect(done.citationViolations).toBe(0);
    nextMemories = [];
  });

  it('cross-capability follow-up: "draft a reply to her last email" reaches the resolver with the resolved person', async () => {
    gateway.structured = [
      rewriteOf("Draft a reply to Ana Kovač's last email", {
        entities: ['Ana Kovač'],
        question_class: 'personal',
      }),
    ];
    await collect(chat.ask(owner, 'draft a reply to her last email'));
    expect(reply.targets.at(-1)).toBe('Ana Kovač');
  });

  it('cross-capability follow-up: "research her company" proposes with the resolved topic', async () => {
    gateway.structured = [rewriteOf("Ana Kovač's company", { entities: ['Ana Kovač'] })];
    const events = await collect(chat.ask(owner, 'research her company'));
    expect(research.proposals.at(-1)).toBe("Ana Kovač's company");
    expect(doneOf(events).content).toContain('nothing has been sent');
  });
});
