import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { ModelGateway } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import type { MemoryRow, MemoryStore } from '../memory/index';
import { RetrievalService } from './retrieval.service';

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
  async *completeStream(): AsyncIterable<string> {
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

describe('create_task intent detection (decision 0038)', () => {
  it('detects explicit en requests and extracts the instruction', async () => {
    const { detectCreateTaskIntent } = await import('./query-rewrite');
    expect(
      detectCreateTaskIntent(
        'Make a task to send Ana the revised mapping once she confirms the format',
      ),
    ).toEqual({
      instruction: 'send Ana the revised mapping once she confirms the format',
      lang: 'en',
      adoptReference: null,
    });
    expect(detectCreateTaskIntent('remind me to follow up with Marko next week')).toEqual({
      instruction: 'follow up with Marko next week',
      lang: 'en',
      adoptReference: null,
    });
    expect(detectCreateTaskIntent('add a task: chase the Baltic Retail contract')).toEqual({
      instruction: 'chase the Baltic Retail contract',
      lang: 'en',
      adoptReference: null,
    });
    expect(detectCreateTaskIntent('Can you create a task to review the SOW?')).toEqual({
      instruction: 'review the SOW',
      lang: 'en',
      adoptReference: null,
    });
  });

  it('detects hr requests and picks the hr normalization language', async () => {
    const { detectCreateTaskIntent } = await import('./query-rewrite');
    expect(
      detectCreateTaskIntent(
        'Napravi zadatak da pošaljem Ani revidirano mapiranje čim potvrdi format',
      ),
    ).toEqual({
      instruction: 'pošaljem Ani revidirano mapiranje čim potvrdi format',
      lang: 'hr',
      adoptReference: null,
    });
    expect(detectCreateTaskIntent('podsjeti me da nazovem Marka')).toEqual({
      instruction: 'nazovem Marka',
      lang: 'hr',
      adoptReference: null,
    });
  });

  it('a bare trigger yields a null instruction; the handler asks, creates nothing', async () => {
    const { detectCreateTaskIntent } = await import('./query-rewrite');
    expect(detectCreateTaskIntent('Add a task')).toEqual({
      instruction: null,
      lang: 'en',
      adoptReference: null,
    });
    expect(detectCreateTaskIntent('Dodaj zadatak')).toEqual({
      instruction: null,
      lang: 'hr',
      adoptReference: null,
    });
  });

  it('the adoption form ("from …") targets an existing memory (P6.5, decision 0054)', async () => {
    const { detectCreateTaskIntent } = await import('./query-rewrite');
    expect(detectCreateTaskIntent("Make a task from Ana's deadline in that contract")).toEqual({
      instruction: null,
      lang: 'en',
      adoptReference: "Ana's deadline in that contract",
    });
    expect(detectCreateTaskIntent('turn that supplier obligation into a task')).toEqual({
      instruction: null,
      lang: 'en',
      adoptReference: 'that supplier obligation',
    });
    expect(detectCreateTaskIntent('Napravi zadatak iz Anine obveze u ugovoru')).toEqual({
      instruction: null,
      lang: 'hr',
      adoptReference: 'Anine obveze u ugovoru',
    });
    // The plain create form is untouched: "to" still captures new content.
    expect(detectCreateTaskIntent('Make a task to send Ana the mapping')).toEqual({
      instruction: 'send Ana the mapping',
      lang: 'en',
      adoptReference: null,
    });
  });

  it('questions about tasks are vetoed — retrieval, not creation', async () => {
    const { detectCreateTaskIntent } = await import('./query-rewrite');
    expect(detectCreateTaskIntent('Did I make a task for Marko?')).toBeNull();
    expect(detectCreateTaskIntent('What tasks are still open?')).toBeNull();
    expect(detectCreateTaskIntent('Jesam li napravio zadatak za Marka?')).toBeNull();
    // Plain conversation never fires the intent.
    expect(detectCreateTaskIntent('The task force meets on Monday')).toBeNull();
  });
});
