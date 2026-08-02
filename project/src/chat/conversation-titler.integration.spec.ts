import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { ModelGateway } from '../model-gateway/index';
import { chatMessage, conversation } from './persistence/tables';
import { ConversationTitler, sanitizeTitle } from './conversation-titler';

/**
 * autotitle_conservative: the title is generated once
 * from the opening messages, plainly; a manual rename ALWAYS wins and is never
 * overwritten — even when the title job lands after the rename.
 */

class TitleGateway extends ModelGateway {
  calls = 0;
  nextTitle = 'Adriatic proposal prep';
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unused');
  }
  async embed(): Promise<number[][]> {
    return [];
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(): Promise<T> {
    this.calls += 1;
    return { title: this.nextTitle } as T;
  }
}

describe('conversation auto-title (integration, real Postgres)', () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await startTestDatabase();
  });
  afterAll(async () => {
    await tdb.stop();
  });

  const seedConversation = async (owner: string, turns: Array<[string, string]>) => {
    const [conv] = await tdb.db.insert(conversation).values({ ownerId: owner }).returning();
    for (const [role, content] of turns) {
      await tdb.db.insert(chatMessage).values({
        ownerId: owner,
        conversationId: conv!.id,
        role: role as 'user' | 'assistant',
        content,
      });
    }
    return conv!.id;
  };
  const titleOf = async (id: string) => {
    const rows = await tdb.db.select().from(conversation);
    return rows.find((r) => r.id === id)!;
  };

  it('autotitle_conservative: titles once from the opening exchange; a re-run changes nothing', async () => {
    const owner = `title-${randomUUID()}`;
    const gateway = new TitleGateway();
    const titler = new ConversationTitler(tdb.db, gateway);
    const id = await seedConversation(owner, [
      ['user', 'Help me prepare the Adriatic Foods proposal'],
      ['assistant', 'Here is what stands out from your notes.'],
    ]);

    const first = await tdb.db.transaction((tx) => titler.run(tx, id));
    expect(first.titled).toBe(true);
    expect((await titleOf(id)).title).toBe('Adriatic proposal prep');
    expect((await titleOf(id)).titleSetByUser).toBe(false);

    // A second run finds the title set and calls no model.
    gateway.nextTitle = 'Something else entirely';
    const again = await tdb.db.transaction((tx) => titler.run(tx, id));
    expect(again.titled).toBe(false);
    expect(gateway.calls).toBe(1);
    expect((await titleOf(id)).title).toBe('Adriatic proposal prep');
  });

  it('autotitle_conservative: a manual rename is never overwritten — before OR mid-flight', async () => {
    const owner = `title-rename-${randomUUID()}`;
    const gateway = new TitleGateway();
    const titler = new ConversationTitler(tdb.db, gateway);
    const id = await seedConversation(owner, [
      ['user', 'Contract questions for Marta'],
      ['assistant', 'Sure.'],
    ]);

    // The user renamed before the job ran: the job declines without a call.
    await tdb.db
      .update(conversation)
      .set({ title: 'Marta contract', titleSetByUser: true })
      .where(eq(conversation.id, id));
    const result = await tdb.db.transaction((tx) => titler.run(tx, id));
    expect(result.titled).toBe(false);
    expect(gateway.calls).toBe(0);
    expect((await titleOf(id)).title).toBe('Marta contract');
  });

  it('autotitle_conservative: sanitizer keeps titles plain — quotes, dashes and length are normalized', () => {
    expect(sanitizeTitle('"Adriatic proposal prep."')).toBe('Adriatic proposal prep');
    expect(sanitizeTitle('Q3 review — invoices')).toBe('Q3 review , invoices');
    expect(sanitizeTitle(`${'long '.repeat(30)}title`).length).toBeLessThanOrEqual(60);
    expect(sanitizeTitle('   ')).toBe('');
  });
});
