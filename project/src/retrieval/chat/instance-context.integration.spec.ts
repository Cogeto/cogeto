import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { startTestDatabase } from '../../testing/index';
import type { TestDatabase } from '../../testing/index';
import { UserDirectory } from '../../identity/index';
import { ModelGateway } from '../../model-gateway/index';
import { formatNow, UserContextService } from '../../infrastructure/index';
import type { RetrievalService } from '../retrieval.service';
import { ChatService } from './chat.service';

/**
 * The now-block in the chat pipeline (P6.6, decisions 0051/0052): every
 * answer-tier and rewriter call carries the user's date/time/context; unset
 * fields are absent; context is never citable; deterministic replies follow
 * the language anchor. Real Postgres, scripted gateway.
 */

const owner: Principal = {
  userId: 'user-ctx-spec',
  name: 'Context Owner',
  email: 'ctx@instance.test',
  orgId: 'org-ctx',
  orgName: 'Org',
  roles: [],
};

const MEM_ID = '44444444-4444-4444-8444-444444444444';

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

const rewriteOf = (query: string, extra: Record<string, unknown> = {}) => ({
  rewritten_query: query,
  entities: [],
  temporal: null,
  open_loops: null,
  question_class: 'personal',
  ...extra,
});

const factOf = (memoryId: string, content: string) => ({
  memory: {
    id: memoryId,
    content,
    status: 'active',
    scope: 'private',
    ownerId: owner.userId,
    sensitive: false,
    subjectEntity: null,
    sourceType: 'user_note',
    sourceId: 'note-1',
    validFrom: null,
    validUntil: null,
    supersededBy: null,
  },
  signals: {},
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

describe('instance context in chat (integration: real Postgres, scripted gateway)', () => {
  let tdb: TestDatabase;
  let gateway: ScriptedGateway;
  let userContext: UserContextService;
  let nextMemories: unknown[];
  let chat: ChatService;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    gateway = new ScriptedGateway();
    userContext = new UserContextService(tdb.db);
    nextMemories = [];
    const retrieval = {
      retrieve: async () => ({ memories: nextMemories, mode: 'default' }),
    } as unknown as RetrievalService;
    chat = new ChatService(
      tdb.db,
      retrieval,
      gateway,
      new UserDirectory(tdb.db),
      undefined,
      undefined,
      'Europe/Zagreb', // the instance timezone — the user's override must win
      userContext,
    );
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  beforeEach(() => {
    gateway.structured = [];
    gateway.structuredCalls = [];
    gateway.streamCalls = [];
    gateway.streamText = '';
    nextMemories = [];
  });

  it('now_block_injected: rewriter and answer inputs carry NOW in the USER timezone', async () => {
    await userContext.update(owner, {
      displayName: 'Ivan',
      roleTitle: 'CTO',
      company: 'MVT Solutions',
      timezone: 'America/Los_Angeles',
    });
    gateway.structured = [rewriteOf('What is due for the migration?')];
    gateway.streamText = 'Nothing pressing.';
    nextMemories = [factOf(MEM_ID, 'The migration cutover is planned.')];

    const before = new Date();
    await collect(chat.ask(owner, 'What is due for the migration?'));
    const after = new Date();

    // Both calls carry a NOW line for the user's zone — not the instance's.
    const rewriterInput = gateway.structuredCalls[0]!;
    const answerInput = gateway.streamCalls[0]!;
    const expected = [
      `NOW: ${formatNow(before, 'America/Los_Angeles')}`,
      `NOW: ${formatNow(after, 'America/Los_Angeles')}`,
    ];
    for (const input of [rewriterInput, answerInput]) {
      expect(expected).toContain(input.split('\n').find((l) => l.startsWith('NOW: ')));
      expect(input).not.toContain('(Europe/Zagreb)');
    }
    // The profile, phrased plainly, reaches the answer input.
    expect(answerInput).toContain('The user is Ivan, CTO at MVT Solutions.');
    // The rewriter gets context but no LANGUAGE line (its output is JSON).
    expect(rewriterInput).toContain('USER CONTEXT');
    expect(rewriterInput).not.toContain('LANGUAGE:');
  });

  it('empty_fields_absent: an unset profile leaves only the NOW line', async () => {
    await userContext.update(owner, {
      displayName: null,
      roleTitle: null,
      company: null,
      aboutWork: null,
      timezone: null,
    });
    gateway.structured = [rewriteOf('What is due for the migration?')];
    gateway.streamText = 'Nothing pressing.';
    nextMemories = [factOf(MEM_ID, 'The migration cutover is planned.')];

    await collect(chat.ask(owner, 'What is due for the migration?'));
    const answerInput = gateway.streamCalls[0]!;
    expect(answerInput).toContain('NOW: ');
    expect(answerInput).toContain('(Europe/Zagreb)'); // override cleared → instance zone
    expect(answerInput).not.toContain('USER CONTEXT');
    expect(answerInput).not.toMatch(/unknown/i);
  });

  it('context_not_cited: a settings-grounded answer stores no citation; memory still cites', async () => {
    await userContext.update(owner, { company: 'MVT Solutions' });

    // No facts on record: with profile context set, the model answers (the
    // zero-retrieval constant would hide the honest settings phrasing).
    gateway.structured = [rewriteOf('Where do I work?')];
    gateway.streamText = 'You have set MVT Solutions as your company in Settings.';
    nextMemories = [];
    const settingsEvents = await collect(chat.ask(owner, 'Where do I work?'));
    const settingsDone = doneOf(settingsEvents);
    expect(settingsDone.content).toContain('MVT Solutions');
    expect(settingsDone.content).not.toContain('{{cite:');
    expect(settingsDone.citationViolations).toBe(0);

    // A memory-backed question still cites the memory.
    gateway.structured = [rewriteOf('Who leads the migration?')];
    gateway.streamText = 'Ana leads the migration [F1].';
    nextMemories = [factOf(MEM_ID, 'Ana leads the migration.')];
    const citedEvents = await collect(chat.ask(owner, 'Who leads the migration?'));
    expect(doneOf(citedEvents).content).toContain(`{{cite:${MEM_ID}}}`);
  });

  it('mirroring_default: the LANGUAGE line mirrors with the preference as tie-breaker', async () => {
    await userContext.update(owner, { preferredLanguage: 'hr', languageStrict: false });
    gateway.structured = [rewriteOf('What is due this week?')];
    gateway.streamText = 'Nothing due.';
    nextMemories = [factOf(MEM_ID, 'The workshop is planned.')];

    await collect(chat.ask(owner, 'What is due this week?'));
    const answerInput = gateway.streamCalls[0]!;
    expect(answerInput).toContain("LANGUAGE: answer in the language of the user's message");
    expect(answerInput).toContain('use Croatian');
  });

  it('strict_mode: the LANGUAGE line pins every reply to the preferred language', async () => {
    await userContext.update(owner, { preferredLanguage: 'hr', languageStrict: true });
    gateway.structured = [rewriteOf('What is due this week?')];
    gateway.streamText = 'Ništa hitno.';
    nextMemories = [factOf(MEM_ID, 'The workshop is planned.')];

    await collect(chat.ask(owner, 'What is due this week?'));
    expect(gateway.streamCalls[0]!).toContain('LANGUAGE: always answer in Croatian');
  });

  it('tiebreak_mixed: the tie-break instruction names the preferred language', async () => {
    await userContext.update(owner, { preferredLanguage: 'hr', languageStrict: false });
    gateway.structured = [rewriteOf('Can you sažmi the workshop plan?')];
    gateway.streamText = 'Plan je spreman.';
    nextMemories = [factOf(MEM_ID, 'The workshop is planned.')];

    await collect(chat.ask(owner, 'Can you sažmi the workshop plan?'));
    expect(gateway.streamCalls[0]!).toContain('when it is mixed or ambiguous, use Croatian');
  });

  it('localizes the deterministic zero-answer replies to the anchor language', async () => {
    // Strict hr user, NO profile fields: the zero-retrieval constant applies
    // and follows the anchor (a deterministic string cannot mirror).
    await userContext.update(owner, {
      preferredLanguage: 'hr',
      languageStrict: false,
      company: null,
      displayName: null,
      roleTitle: null,
      aboutWork: null,
    });
    gateway.structured = [rewriteOf('Tko vodi projekt Jadran?')];
    nextMemories = [];
    const events = await collect(chat.ask(owner, 'Tko vodi projekt Jadran?'));
    expect(doneOf(events).content).toContain('O tome još nemam ništa');
    expect(gateway.streamCalls).toHaveLength(0); // no model call, as before
  });
});
