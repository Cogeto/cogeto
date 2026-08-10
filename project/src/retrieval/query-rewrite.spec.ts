import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { ModelGateway } from '../model-gateway/index';
import type { StreamDelta } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import type { MemoryRow, MemoryStore } from '../memory/index';
import { RetrievalService } from './retrieval.service';
import { queryEntityCandidates } from './query-entities';

/**
 * pronoun_rewrite (owner test F3): a turn that leans on the conversation
 * ("who is she?") triggers the rewriter, and the rewriter's output (the
 * resolved query + entity) drives retrieval.
 */

const principal: Principal = {
  userId: 'u',
  name: 'U',
  email: null,
  orgId: 'o',
  orgName: 'O',
  roles: [],
};

const anaRow = {
  id: 'ana-1',
  ownerId: 'u',
  scope: 'private',
  status: 'active',
  sensitive: false,
  entities: ['Ana Kovač'],
  subjectEntity: 'Ana Kovač',
  content: 'Ana Kovač is the main contact at Adriatic Foods',
  sourceType: 'user_note',
  sourceId: 'n1',
  validFrom: new Date('2026-07-03T00:00:00Z'),
  validUntil: null,
  createdAt: new Date('2026-07-03T00:00:00Z'),
} as unknown as MemoryRow;

class RewriteGateway extends ModelGateway {
  rewriteRequests: StructuredExtractionRequest[] = [];
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used
  async *completeStream(): AsyncIterable<StreamDelta> {
    throw new Error('not used');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0, 0, 0, 0, 0, 0]);
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    this.rewriteRequests.push(request);
    return schema.parse({ rewritten_query: 'Who is Ana Kovač?', entities: ['Ana Kovač'] });
  }
}

/** Records the names entitySearch was asked for; returns Ana for her variants. */
function fakeStore(entityNamesSeen: string[][]): MemoryStore {
  return {
    vectorSearch: async () => [],
    ftsSearch: async () => [],
    entitySearch: async (_p: Principal, names: string[]) => {
      entityNamesSeen.push(names);
      return names.some((n) => n.toLowerCase().includes('ana'))
        ? [{ memory: anaRow, score: 1 }]
        : [];
    },
    getManyForPrincipal: async () => [],
  } as unknown as MemoryStore;
}

describe('pronoun_rewrite (F3)', () => {
  it('invokes the rewriter for a pronoun turn and its output drives retrieval', async () => {
    const gateway = new RewriteGateway();
    const entityNamesSeen: string[][] = [];
    const service = new RetrievalService(fakeStore(entityNamesSeen), gateway);

    const result = await service.retrieve(principal, 'Remind me — who is she, exactly?', {
      history: [
        { role: 'user', content: 'Tell me about the Atlas CRM migration.' },
        { role: 'assistant', content: 'Ana Kovač at Adriatic Foods is the main contact.' },
      ],
    });

    // The rewriter ran, and saw the pronoun turn + the conversation.
    expect(gateway.rewriteRequests).toHaveLength(1);
    expect(gateway.rewriteRequests[0]!.input).toMatch(/who is she/i);
    expect(gateway.rewriteRequests[0]!.input).toContain('Atlas CRM migration');

    // Its output drove retrieval: entity search was asked for Ana Kovač, and the
    // resolved question put us in entity-profile mode focused on her.
    expect(entityNamesSeen.flat()).toContain('Ana Kovač');
    expect(result.mode).toBe('entity_profile');
    expect(result.focusEntity).toBe('Ana Kovač');
    expect(result.memories.map((m) => m.memory.id)).toContain('ana-1');
  });

  it('skips the rewriter for a self-contained, non-trivial question', async () => {
    const gateway = new RewriteGateway();
    const service = new RetrievalService(fakeStore([]), gateway);
    await service.retrieve(principal, 'What is the overall Atlas CRM migration timeline?');
    expect(gateway.rewriteRequests).toHaveLength(0);
  });
});

/**
 * Issue #477: a lowercase identifier must be a deterministic query-entity
 * candidate. On the live instance `what is m557?` contributed none, so naming
 * fell to the model rewrite and the answer flipped between correct and
 * "I have nothing about this in your sources" on identical input.
 */
describe('query entity candidates: identifiers (issue #477)', () => {
  it('names a lowercase identifier the user typed', () => {
    expect(queryEntityCandidates('what is m557?')).toContain('m557');
  });

  it('names identifiers however they are cased or punctuated', () => {
    expect(queryEntityCandidates('what is M557?')).toContain('M557');
    expect(queryEntityCandidates('specs for rp2040 please')).toContain('rp2040');
    expect(queryEntityCandidates('is sen-210 affected')).toContain('sen-210');
  });

  it('does not treat a plain word or a plain number as an identifier', () => {
    // The rule is deliberately narrow: only letters AND digits in one token.
    expect(queryEntityCandidates('what is brass')).not.toContain('brass');
    expect(queryEntityCandidates('what happened in 2027')).not.toContain('2027');
  });

  it('joins an identifier onto the capitalized run it follows', () => {
    expect(queryEntityCandidates('the Fuze M557 weight')).toContain('Fuze M557');
  });
});
