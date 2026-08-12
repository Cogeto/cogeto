import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { chatMessage, conversation } from './persistence/tables';
import { MATCH_CLOSE, MATCH_OPEN, searchConversations } from './conversation-search';

/**
 * Conversation search (issue #530), against real Postgres, because the whole
 * feature IS the SQL: the generated tsvector from migration 0057, the GIN
 * index, and `websearch_to_tsquery`.
 *
 *   search_finds_by_content — the point of the feature: a thread found by what
 *     was said in it, not by the two-to-six words a model titled it with.
 *   search_finds_by_title — a hand-renamed thread is findable by that name.
 *   search_one_result_per_conversation — a thread saying it nine times is one
 *     result carrying its BEST line, not nine results.
 *   search_is_owner_scoped — another user's conversations never appear.
 *   search_includes_archived — the archived thread is exactly the one
 *     scrolling cannot find, so search must reach it.
 *   search_is_accent_insensitive — "Zavarivanje" is found by "zavarivanje",
 *     the same folding the fact search does.
 *   search_snippet_marks_the_match — the matched words come back wrapped in
 *     sentinels the client splits on, never as markup.
 *   search_untitled_is_findable — the case title-only search cannot serve:
 *     a conversation the auto-titler never named.
 */

const OWNER = 'user-search';
const OTHER = 'user-other';

describe('conversation search (integration, real Postgres)', () => {
  let tdb: TestDatabase;

  const newConversation = async (
    ownerId: string,
    title: string | null,
    archived = false,
  ): Promise<string> => {
    const [row] = await tdb.db
      .insert(conversation)
      .values({ ownerId, title, archived })
      .returning();
    return row!.id;
  };

  const say = async (ownerId: string, conversationId: string, content: string) => {
    await tdb.db.insert(chatMessage).values({ ownerId, conversationId, role: 'user', content });
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
  }, 180_000);
  afterAll(async () => {
    await tdb.stop();
  });

  it('search_finds_by_content: the thread is found by what was said, not its title', async () => {
    const id = await newConversation(OWNER, 'Thursday notes');
    await say(OWNER, id, 'The fastening torque on the M557 flange is 3.2 Nm.');

    const hits = await searchConversations(tdb.db, OWNER, 'fastening torque');
    expect(hits.map((hit) => hit.conversationId)).toContain(id);
    const hit = hits.find((h) => h.conversationId === id)!;
    // It points at the MESSAGE, so the client can land on that exact turn.
    expect(hit.messageId).toBeTruthy();
    expect(hit.matchedTitle).toBe(false);
  });

  it('search_finds_by_title: a hand-renamed thread is findable by that name', async () => {
    const id = await newConversation(OWNER, 'Arkona frame delivery');
    await say(OWNER, id, 'Nothing in here uses that word.');

    const hits = await searchConversations(tdb.db, OWNER, 'Arkona');
    const hit = hits.find((h) => h.conversationId === id);
    expect(hit).toBeTruthy();
    expect(hit!.matchedTitle).toBe(true);
    // Title-only, so there is no line to quote: the title is the answer.
    expect(hit!.snippet).toBe(null);
    expect(hit!.messageId).toBe(null);
  });

  it('search_one_result_per_conversation: many mentions collapse to the best line', async () => {
    const id = await newConversation(OWNER, 'Tolerance thread');
    await say(OWNER, id, 'tolerance mentioned once');
    await say(OWNER, id, 'tolerance tolerance tolerance, the dense one');
    await say(OWNER, id, 'tolerance again');

    const hits = await searchConversations(tdb.db, OWNER, 'tolerance');
    const mine = hits.filter((hit) => hit.conversationId === id);
    expect(mine).toHaveLength(1);
    // And the line it kept is the densest, not merely the newest.
    expect(mine[0]!.snippet).toContain('dense one');
  });

  it("search_is_owner_scoped: another user's conversations never appear", async () => {
    const theirs = await newConversation(OTHER, 'Their private planning');
    await say(OTHER, theirs, 'A distinctive phrase: chinchilla escapement.');

    const asOwner = await searchConversations(tdb.db, OWNER, 'chinchilla escapement');
    expect(asOwner.map((hit) => hit.conversationId)).not.toContain(theirs);
    // The row is genuinely there; only the gate keeps it out.
    const asThem = await searchConversations(tdb.db, OTHER, 'chinchilla escapement');
    expect(asThem.map((hit) => hit.conversationId)).toContain(theirs);
  });

  it('search_includes_archived: the thread scrolling cannot find is reachable', async () => {
    const id = await newConversation(OWNER, 'Old quarter planning', true);
    await say(OWNER, id, 'The agreed figure was 4200 EUR for the whole batch.');

    const hits = await searchConversations(tdb.db, OWNER, 'agreed figure');
    expect(hits.map((hit) => hit.conversationId)).toContain(id);
  });

  it('search_is_accent_insensitive, like the fact search', async () => {
    const id = await newConversation(OWNER, null);
    await say(OWNER, id, 'Zavarivanje je gotovo u utorak.');

    const folded = await searchConversations(tdb.db, OWNER, 'zavarivanje');
    expect(folded.map((hit) => hit.conversationId)).toContain(id);
  });

  it('search_snippet_marks_the_match with sentinels, never markup', async () => {
    const id = await newConversation(OWNER, 'Snippet check');
    await say(OWNER, id, 'The calibration certificate expires in March next year.');

    const hits = await searchConversations(tdb.db, OWNER, 'calibration certificate');
    const snippet = hits.find((hit) => hit.conversationId === id)!.snippet!;
    expect(snippet).toContain(MATCH_OPEN);
    expect(snippet).toContain(MATCH_CLOSE);
    // No HTML is ever produced, so nothing downstream can be asked to inject it.
    expect(snippet).not.toContain('<');
    expect(snippet).not.toContain('&');
  });

  it('search_untitled_is_findable: the case a title-only search could never serve', async () => {
    // `title` is NULL until the first exchange is auto-titled, and the titler
    // can fail into the dead-letter queue. This thread has no title at all.
    const id = await newConversation(OWNER, null);
    await say(OWNER, id, 'Remember the quench tank runs at eleven degrees.');

    const hits = await searchConversations(tdb.db, OWNER, 'quench tank');
    expect(hits.map((hit) => hit.conversationId)).toContain(id);
  });

  it('search_empty_query_returns_nothing rather than everything', async () => {
    expect(await searchConversations(tdb.db, OWNER, '   ')).toEqual([]);
  });
});
