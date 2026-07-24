import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import {
  auditLog,
  contextSuggestionDismissal,
  userContext,
  UserContextService,
} from '../infrastructure/index';
import { ModelGateway } from '../model-gateway/index';
import type { MemoryRow, MemoryStore } from '../memory/index';
import { ContextSuggestionsService } from './context-suggestions.service';

/**
 * Derived context suggestions (P6.6 Issue C, decision 0053): conservative by
 * construction — conflicting or unconfirmed evidence proposes nothing; an
 * accepted suggestion records its memory provenance; user-set and dismissed
 * values are never overridden or re-proposed.
 */

const owner: Principal = {
  userId: 'user-suggest-spec',
  name: 'Ivan',
  email: null,
  orgId: 'org-s',
  orgName: 'Org',
  roles: [],
};

const MEM_A = '66666666-6666-4666-8666-666666666661';
const MEM_B = '66666666-6666-4666-8666-666666666662';

const memoryOf = (id: string, content: string, daysAgo = 1): MemoryRow =>
  ({
    id,
    ownerId: owner.userId,
    status: 'active',
    content,
    sourceType: 'user_note',
    createdAt: new Date(Date.now() - daysAgo * 86_400_000),
  }) as unknown as MemoryRow;

/** A gateway whose confirmation verdict is scripted per test. */
class VerdictGateway extends ModelGateway {
  verdict: unknown = { company: { confirmed: true }, role_title: { confirmed: true } };
  calls = 0;
  complete(): never {
    throw new Error('unexpected');
  }
  // eslint-disable-next-line require-yield
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unexpected');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0]);
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(): Promise<T> {
    this.calls += 1;
    return this.verdict as T;
  }
}

describe('context suggestions (integration: real Postgres, scripted gateway)', () => {
  let tdb: TestDatabase;
  let contextService: UserContextService;
  let gateway: VerdictGateway;
  let rows: MemoryRow[];
  let service: ContextSuggestionsService;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    contextService = new UserContextService(tdb.db);
    gateway = new VerdictGateway();
    rows = [];
    const memories = {
      listForPrincipal: async () => rows,
    } as unknown as MemoryStore;
    service = new ContextSuggestionsService(memories, contextService, gateway);
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  beforeEach(async () => {
    gateway.verdict = { company: { confirmed: true }, role_title: { confirmed: true } };
    gateway.calls = 0;
    rows = [];
    // A clean slate per test: no context row, no dismissals.
    await tdb.db.delete(userContext).where(eq(userContext.userId, owner.userId));
    await tdb.db
      .delete(contextSuggestionDismissal)
      .where(eq(contextSuggestionDismissal.userId, owner.userId));
  });

  it('proposes a confirmed, single-valued company with its newest source', async () => {
    rows = [
      memoryOf(MEM_A, 'I work at MVT Solutions as of this spring.', 5),
      memoryOf(MEM_B, 'Met Marko; I work at MVT Solutions on the CRM rollout.', 2),
    ];
    const suggestions = await service.suggestions(owner);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      field: 'company',
      value: 'MVT Solutions',
      sourceMemoryId: MEM_B, // newest supporting memory is the shown source
      sourceLabel: 'note',
    });
  });

  it('suggestion_conservative: conflicting or unconfirmed evidence proposes nothing', async () => {
    // Two distinct companies → no candidate, no model call for the field.
    rows = [
      memoryOf(MEM_A, 'I work at MVT Solutions.'),
      memoryOf(MEM_B, 'I work at Adriatic Foods.'),
    ];
    expect(await service.suggestions(owner)).toEqual([]);

    // One candidate, but the confirmation pass rejects it → nothing.
    rows = [memoryOf(MEM_A, 'I work at MVT Solutions.')];
    gateway.verdict = { company: { confirmed: false }, role_title: null };
    expect(await service.suggestions(owner)).toEqual([]);

    // Past-tense evidence never becomes a candidate at all.
    rows = [memoryOf(MEM_A, 'I used to work at Adriatic Foods. I work at nothing now.')];
    gateway.verdict = { company: { confirmed: true }, role_title: null };
    expect(await service.suggestions(owner)).toEqual([]);
  });

  it('suggestion_provenance: accepting records which memory suggested the value', async () => {
    await contextService.applySuggestion(owner, 'company', 'MVT Solutions', MEM_B);

    const [row] = await tdb.db
      .select()
      .from(userContext)
      .where(eq(userContext.userId, owner.userId));
    expect(row!.company).toBe('MVT Solutions');
    expect(row!.companySourceMemoryId).toBe(MEM_B);

    const audits = await tdb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'context.suggestion_accepted'));
    const mine = audits.filter((a) => a.entityId === owner.userId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.at(-1)!.detailJson).toMatchObject({
      field: 'company',
      derivedFromMemoryId: MEM_B,
    });
  });

  it('suggestion_respects_user: set or dismissed values are never overridden or re-proposed', async () => {
    rows = [memoryOf(MEM_A, 'I work at MVT Solutions.')];

    // An explicit user value: the field is set, so it is never re-derived.
    await contextService.update(owner, { company: 'Handwritten Ltd' });
    expect(await service.suggestions(owner)).toEqual([]);
    const [afterUpdate] = await tdb.db
      .select()
      .from(userContext)
      .where(eq(userContext.userId, owner.userId));
    expect(afterUpdate!.company).toBe('Handwritten Ltd');
    expect(afterUpdate!.companySourceMemoryId).toBeNull(); // user value, no provenance

    // Cleared again + dismissed: the same value never returns.
    await contextService.update(owner, { company: null });
    await contextService.dismissSuggestion(owner, 'company', 'MVT Solutions');
    expect(await service.suggestions(owner)).toEqual([]);

    // A user edit also clears an earlier suggestion provenance.
    await contextService.applySuggestion(owner, 'roleTitle', 'CTO', MEM_A);
    await contextService.update(owner, { roleTitle: 'Chief Technology Officer' });
    const [afterEdit] = await tdb.db
      .select()
      .from(userContext)
      .where(eq(userContext.userId, owner.userId));
    expect(afterEdit!.roleTitleSourceMemoryId).toBeNull();
  });
});
