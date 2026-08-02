import { describe, expect, it } from 'vitest';
import type { ChatFactDto, Principal } from '@cogeto/shared';
import type { MemoryRow, MemoryStore } from '../memory/index';
import type { ModelGateway } from '../model-gateway/index';
import { buildAnswerInput } from '../chat/index';
import { RetrievalService } from './retrieval.service';
import type { OpenLoop } from './retrieval.service';

/**
 * open_loops_memory_backed: the day-one
 * question's second half is answered from memory rows, with no derived table
 * behind it. Two things are pinned here, both pure
 *
 *  1. the retrieval mode reads `openLoopsForPrincipal` and returns the facts
 *     themselves as the citable memories, entity narrowing included;
 *  2. the answer input renders each loop with its due date (from the memory's
 *     own `valid_until`), its quiet marker and its unconfirmed marker, cited to
 *     the fact — so every line the answerer writes can carry a marker.
 *
 * The gate behavior (scope, sensitive, settled statuses) is proven against a
 * real database in cross-user-scope.integration.spec.ts.
 */

const principal: Principal = {
  userId: 'ana',
  name: 'Ana',
  email: null,
  orgId: 'org',
  orgName: 'Org',
  roles: [],
};

const row = (over: Partial<MemoryRow> & { id: string }): MemoryRow =>
  ({
    content: 'You will send Luka the revised offer.',
    ownerId: principal.userId,
    scope: 'private',
    status: 'active',
    kind: 'commitment',
    entities: ['Luka'],
    subjectEntity: 'Luka',
    sourceType: 'user_note',
    sourceId: 'n1',
    sensitive: false,
    validFrom: null,
    validUntil: null,
    supersededBy: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  }) as unknown as MemoryRow;

/** The rewriter's output for "what's still open [with X]", precomputed. */
const openLoopsRewrite = (entity: string | null) => ({
  query: 'what is still open',
  entities: entity ? [entity] : [],
  temporal: null,
  openLoops: { entity },
  emailReply: null,
  questionClass: 'personal' as const,
});

const gateway = {
  embed: () => {
    throw new Error('the open-loops path must not embed anything');
  },
} as unknown as ModelGateway;

describe('open_loops_memory_backed', () => {
  it('the open-loops mode reads memory and returns the facts as the citable rows', async () => {
    const seen: { entity?: string }[] = [];
    const store = {
      openLoopsForPrincipal: async (_p: Principal, opts: { entity?: string }) => {
        seen.push(opts);
        return [row({ id: 'm1' }), row({ id: 'm2', content: 'You owe Ana the risk register.' })];
      },
    } as unknown as MemoryStore;

    const service = new RetrievalService(store, gateway);
    const result = await service.retrieve(principal, "what's still open?", {
      rewrite: openLoopsRewrite(null),
    });

    expect(result.mode).toBe('open_loops');
    // The memories ARE the open loops — nothing is resolved through a second id.
    expect(result.memories.map((m) => m.memory.id)).toEqual(['m1', 'm2']);
    expect(result.openLoops?.map((l) => l.memory.id)).toEqual(['m1', 'm2']);
    // Without a database handle there is no dormancy signal, and that is not an
    // error — the loop is simply not marked quiet.
    expect(result.openLoops?.every((l) => l.dormant === false)).toBe(true);
    expect(seen).toEqual([{ entity: undefined, includeSensitive: undefined }]);
  });

  it('the entity-scoped variant narrows inside the gated read, not after it', async () => {
    const seen: { entity?: string }[] = [];
    const store = {
      openLoopsForPrincipal: async (_p: Principal, opts: { entity?: string }) => {
        seen.push(opts);
        return [row({ id: 'm1' })];
      },
    } as unknown as MemoryStore;

    const service = new RetrievalService(store, gateway);
    const result = await service.retrieve(principal, "what's still open with Luka?", {
      rewrite: openLoopsRewrite('Luka'),
    });

    expect(result.mode).toBe('open_loops');
    expect(seen[0]?.entity).toBe('Luka');
  });

  it('the answer input renders due dates, quiet and unconfirmed markers, each cited', () => {
    const loops: OpenLoop[] = [
      {
        memory: row({
          id: 'm1',
          validUntil: new Date('2026-07-10T00:00:00.000Z'),
        }),
        dormant: false,
      },
      {
        memory: row({ id: 'm2', content: 'You owe Ana the risk register.' }),
        dormant: true,
      },
      {
        memory: row({ id: 'm3', content: 'Maybe you promised Vera a call.', status: 'uncertain' }),
        dormant: false,
      },
    ];
    const facts: ChatFactDto[] = loops.map((loop, i) => ({
      memoryId: loop.memory.id,
      marker: `F${i + 1}`,
      claim: loop.memory.content,
      status: loop.memory.status,
      sourceType: 'user_note',
      subjectEntity: loop.memory.subjectEntity,
      validFrom: null,
      validUntil: loop.memory.validUntil?.toISOString() ?? null,
      pastBelief: false,
      supersededBy: null,
      ownerId: principal.userId,
      ownerName: null,
    }));

    const input = buildAnswerInput(facts, "what's still open?", 'open_loops', { openLoops: loops });

    expect(input).toContain('MODE: open_loops');
    expect(input).toContain('OPEN LOOPS (what is still standing — answer from THESE):');
    // Each entry carries its marker, so every answer line can be cited.
    expect(input).toContain('- [F1] You will send Luka the revised offer. | due: 2026-07-10');
    expect(input).toContain('- [F2] You owe Ana the risk register. | quiet for a while');
    expect(input).toContain('- [F3] Maybe you promised Vera a call. | unconfirmed');
    // No task vocabulary reaches the model.
    expect(input.toLowerCase()).not.toContain('blocked_on_condition');
    expect(input.toLowerCase()).not.toContain('waiting on:');
  });
});
