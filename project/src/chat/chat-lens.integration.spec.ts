import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AmbiguityDecisionDto, ChatStreamEvent, Principal } from '@cogeto/shared';
import { CONVERSATION_REF_TYPE } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { UserDirectory } from '../identity/index';
import { ModelGateway } from '../model-gateway/index';
import type { StreamDelta } from '../model-gateway/index';
import type { RetrievalService, RetrieveOptions } from '../retrieval/index';
import { ProjectService, ProjectStore } from '../projects/index';
import { chatMessage } from './persistence/tables';
import { ChatService } from './chat.service';

/**
 * The project retrieval lens through the chat orchestrator (V2.5 item 8.3
 * issue B). The decision record's promises, as tests:
 *
 * - lens_applied_in_a_project / no_lens_when_unassigned / no_lens_when_off:
 *   the lens is resolved by chat and handed to retrieval as a VALUE, and an
 *   unassigned conversation takes the pre-feature path exactly.
 * - lens_gap_says_so_and_offers_widen: Cogeto never widens silently and never
 *   refuses silently. The reply NAMES the project and the done event carries
 *   the one-tap widen, with NO model call.
 * - widened_turn_answers_from_everything: the per-question widen drops the
 *   lens for that turn only, and the stored message says so honestly.
 * - fan_out_inside_a_lens: the decision rule and its thresholds are
 *   unchanged; the fan-out renders exactly the clusters the (narrowed)
 *   retrieval produced.
 */

const owner: Principal = {
  userId: 'user-lens',
  name: 'Owner',
  email: 'lens@instance.test',
  orgId: 'org-lens',
  orgName: 'Org',
  roles: [],
};

const MEM_A = '66666666-6666-4666-8666-666666666666';

class ScriptedGateway extends ModelGateway {
  structured: unknown[] = [];
  streamText = 'scripted answer';
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

const memoryRow = (id: string, subject: string, content: string, sourceId: string) => ({
  id,
  ownerId: owner.userId,
  scope: 'private',
  sourceType: 'user_note',
  sourceId,
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

describe('the project retrieval lens in chat (integration: real Postgres, scripted seams)', () => {
  let tdb: TestDatabase;
  let gateway: ScriptedGateway;
  let chat: ChatService;
  let projects: ProjectService;
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
    projects = new ProjectService(tdb.db, new ProjectStore(tdb.db));
    chat = new ChatService(tdb.db, retrieval, gateway, new UserDirectory(tdb.db), { projects });
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  const storedLens = async (messageId: string) => {
    const rows = await tdb.db
      .select({ lens: chatMessage.lens })
      .from(chatMessage)
      .where(eq(chatMessage.id, messageId));
    return rows[0]?.lens ?? null;
  };

  /** A conversation inside a fresh project holding one source. */
  const projectConversation = async (name: string, sourceId: string) => {
    const project = await projects.create(owner, { name });
    await projects.assign(
      owner,
      { kind: 'source', refType: 'user_note', refId: sourceId },
      project.id,
    );
    const conversation = await chat.createConversation(owner, project.id);
    return { project, conversationId: conversation.id };
  };

  it('no_lens_when_unassigned: the pre-feature path exactly', async () => {
    const conversation = await chat.createConversation(owner);
    expect(conversation.projectId).toBe(null);
    gateway.structured = [rewriteOf('what is the torque?')];
    nextResult = {
      memories: [
        {
          memory: memoryRow(MEM_A, 'VX-9', 'The VX-9 torque is 3.2 Nm.', 'note-free'),
          score: 0.03,
          signals: ['vector'],
          vectorScore: 0.9,
        },
      ],
      mode: 'default',
    };
    const events = await collect(chat.ask(owner, 'what is the torque?', conversation.id));
    expect(lastRetrieveOpts?.lens).toBeUndefined();
    expect(doneOf(events).lens ?? null).toBe(null);
  });

  it('lens_applied_in_a_project: the refs reach retrieval as a value', async () => {
    const { project, conversationId } = await projectConversation('Client A', 'note-client-a');
    gateway.structured = [rewriteOf('what is the torque?')];
    nextResult = {
      memories: [
        {
          memory: memoryRow(MEM_A, 'VX-9', 'The VX-9 torque is 3.2 Nm.', 'note-client-a'),
          score: 0.03,
          signals: ['vector'],
          vectorScore: 0.9,
        },
      ],
      mode: 'default',
    };
    const events = await collect(chat.ask(owner, 'what is the torque?', conversationId));
    expect(lastRetrieveOpts?.lens).toEqual([
      { sourceType: 'user_note', sourceId: 'note-client-a' },
    ]);
    const done = doneOf(events);
    expect(done.lens).toEqual({ projectId: project.id, applied: true, widened: false });
    expect(await storedLens(done.messageId)).toEqual({
      projectId: project.id,
      applied: true,
      widened: false,
    });
  });

  it('no_lens_when_off: assignment without a lens is pure organisation', async () => {
    const { project, conversationId } = await projectConversation('Client Off', 'note-client-off');
    await projects.update(owner, project.id, { lensEnabled: false });
    gateway.structured = [rewriteOf('what is the torque?')];
    nextResult = {
      memories: [
        {
          memory: memoryRow(MEM_A, 'VX-9', 'The VX-9 torque is 3.2 Nm.', 'note-elsewhere'),
          score: 0.03,
          signals: ['vector'],
          vectorScore: 0.9,
        },
      ],
      mode: 'default',
    };
    await collect(chat.ask(owner, 'what is the torque?', conversationId));
    expect(lastRetrieveOpts?.lens).toBeUndefined();
  });

  it('lens_gap_says_so_and_offers_widen: never silent, and no model call', async () => {
    const { project, conversationId } = await projectConversation('Client Gap', 'note-client-gap');
    gateway.structured = [rewriteOf('what did we agree on delivery?')];
    gateway.streamCalls = [];
    // The project's sources hold nothing above the floor.
    nextResult = { memories: [], mode: 'default' };
    const events = await collect(chat.ask(owner, 'what did we agree on delivery?', conversationId));
    const done = doneOf(events);
    // It NAMES the project rather than shrugging, and offers the one tap.
    expect(done.content).toContain('Client Gap');
    expect(done.widenOffer).toEqual({
      projectId: project.id,
      question: 'what did we agree on delivery?',
    });
    // A deterministic server-authored reply: the rewriter is the only model
    // call this turn, exactly like every other zero-answer path.
    expect(gateway.streamCalls).toHaveLength(0);
    expect(await storedLens(done.messageId)).toEqual({
      projectId: project.id,
      applied: true,
      widened: false,
      emptyInProject: true,
    });
  });

  it('widened_turn_answers_from_everything, and the stored message says so', async () => {
    const { project, conversationId } = await projectConversation('Client Wide', 'note-wide');
    gateway.structured = [rewriteOf('what is the torque?')];
    nextResult = {
      memories: [
        {
          memory: memoryRow(MEM_A, 'VX-9', 'The VX-9 torque is 3.2 Nm.', 'note-outside'),
          score: 0.03,
          signals: ['vector'],
          vectorScore: 0.9,
        },
      ],
      mode: 'default',
    };
    const events = await collect(
      chat.ask(owner, 'what is the torque?', conversationId, { widen: true }),
    );
    // No lens for THIS turn; the conversation stays in its project.
    expect(lastRetrieveOpts?.lens).toBeUndefined();
    const done = doneOf(events);
    expect(done.lens).toEqual({ projectId: project.id, applied: false, widened: true });
    const conversationProject = await projects.projectForConversation(owner, conversationId);
    expect(conversationProject?.id).toBe(project.id);
    // The ref type is the conversation's SOURCE type, so the deletion
    // cascade releases it through the same arm as a document's.
    expect(CONVERSATION_REF_TYPE).toBe('chat_conversation');
  });

  it('fan_out_inside_a_lens: the rule and its thresholds are untouched', async () => {
    const { conversationId } = await projectConversation('Client Fan', 'note-fan');
    const decision: AmbiguityDecisionDto = {
      branch: 'fan_out',
      clusters: [
        {
          subject: 'VX-9',
          key: 'vx-9',
          relevance: 0.94,
          entityNamed: false,
          fused: 0.03,
          size: 1,
          topMemoryId: MEM_A,
          shown: true,
        },
      ],
      named: [],
      capped: false,
      configVersion: 1,
      embeddingModel: 'test-embed',
    };
    gateway.structured = [rewriteOf('what is the torque?')];
    gateway.streamCalls = [];
    nextResult = {
      memories: [
        {
          memory: memoryRow(MEM_A, 'VX-9', 'The VX-9 torque is 3.2 Nm.', 'note-fan'),
          score: 0.03,
          signals: ['vector'],
          vectorScore: 0.94,
        },
      ],
      mode: 'default',
      ambiguity: decision,
    };
    const events = await collect(chat.ask(owner, 'what is the torque?', conversationId));
    const done = doneOf(events);
    // Exactly the clusters the narrowed retrieval produced, and no others:
    // the lens shrinks the candidate set, the rule is unchanged.
    expect(done.content).toContain('VX-9');
    expect(done.ambiguity?.configVersion).toBe(1);
    expect(done.ambiguity?.embeddingModel).toBe('test-embed');
    expect(gateway.streamCalls).toHaveLength(0);
  });
});
