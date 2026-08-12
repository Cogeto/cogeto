import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { loadDuplicateGroups, partitionPlans, planFor } from './dedupe-plan';

/**
 * The query behind `dedupe-file-sources` (issue #538), against real Postgres,
 * because the query IS the safety.
 *
 * Every number the command acts on comes from here: which copies group
 * together, how many facts each carries, and above all how many stored
 * ANSWERS cite each one. A wrong citation count is the expensive failure: it
 * would let the command delete the copy a user's answer points at, and the
 * redaction cascade would then replace that answer with a sentence saying its
 * source is gone. So the citation arm is tested from both sides.
 *
 *   groups_by_admission_not_just_hash — a scope or sensitive difference is not
 *     a duplicate, exactly as the upload rule of #536 has it.
 *   singletons_never_appear — one copy is not a duplicate.
 *   null_checksums_never_group — discard mode writes no checksum, and NULL is
 *     not equal to NULL.
 *   counts_facts_per_copy — each copy's own provenance, not the group's.
 *   counts_citing_answers_per_copy — the number that decides the survivor.
 *   only_assistant_answers_count — a user typing the token is not a citation.
 *   the_cited_copy_survives — the rule and the query, end to end.
 */

const OWNER = 'user-dedupe';
const HASH = 'a'.repeat(64);

describe('finding duplicate file sources (integration, real Postgres)', () => {
  let tdb: TestDatabase;

  const addFile = async (
    key: string,
    over: { checksum?: string | null; scope?: string; sensitive?: boolean; day?: number } = {},
  ) => {
    await tdb.db.execute(sql`
      INSERT INTO file_metadata (object_key, owner_id, scope, sensitive, upload_date, checksum, size_bytes)
      VALUES (${`org-1/${OWNER}/private/${key}`}, ${OWNER},
              ${over.scope ?? 'private'}::scope, ${over.sensitive ?? false},
              ${`2026-08-${String(over.day ?? 3).padStart(2, '0')}T09:00:00Z`}::timestamptz,
              ${over.checksum === undefined ? HASH : over.checksum}, 100)
    `);
  };

  /** A fact with this copy as its provenance; returns its memory id. */
  const addFact = async (key: string, content: string): Promise<string> => {
    const { rows } = await tdb.db.execute<{ id: string }>(sql`
      INSERT INTO memory (owner_id, content, kind, scope, sensitive, status, source_type, source_id)
      VALUES (${OWNER}, ${content}, 'fact', 'private', false, 'active', 'file',
              ${`org-1/${OWNER}/private/${key}`})
      RETURNING id
    `);
    return rows[0]!.id;
  };

  const addAnswer = async (memoryId: string, role = 'assistant') => {
    const { rows } = await tdb.db.execute<{ id: string }>(
      sql`INSERT INTO conversation (owner_id) VALUES (${OWNER}) RETURNING id`,
    );
    await tdb.db.execute(sql`
      INSERT INTO chat_message (owner_id, conversation_id, role, content)
      VALUES (${OWNER}, ${rows[0]!.id}::uuid, ${role},
              ${`The flange ships on 12 March {{cite:${memoryId}}}.`})
    `);
  };

  const groupFor = async (checksum: string) =>
    (await loadDuplicateGroups(tdb.db)).find((group) => group.checksum === checksum);

  beforeAll(async () => {
    tdb = await startTestDatabase();
  }, 180_000);
  afterAll(async () => {
    await tdb.stop();
  });

  it('singletons_never_appear and null_checksums_never_group', async () => {
    await addFile('file-lonely', { checksum: 'b'.repeat(64) });
    // Two discard-era rows with no checksum at all. They are not duplicates of
    // each other, however identical they look, because nothing says they are.
    await addFile('file-nohash-1', { checksum: null });
    await addFile('file-nohash-2', { checksum: null });

    expect(await loadDuplicateGroups(tdb.db)).toEqual([]);
  });

  it('groups_by_admission_not_just_hash: scope and sensitive keep copies apart', async () => {
    const shared = 'c'.repeat(64);
    await addFile('file-priv', { checksum: shared });
    await addFile('file-shared', { checksum: shared, scope: 'shared' });
    await addFile('file-sensitive', { checksum: shared, sensitive: true });

    // Three rows, one hash, and NOT a duplicate group: upload deliberately
    // refuses to answer a request for `shared` with a `private` source
    // (#536), so cleanup must not merge what upload keeps apart.
    expect(await groupFor(shared)).toBeUndefined();

    // A fourth row that matches one of them on all four columns does group.
    await addFile('file-priv-again', { checksum: shared, day: 4 });
    const group = await groupFor(shared);
    expect(group?.copies.map((copy) => copy.objectKey.split('/').pop())).toEqual([
      'file-priv',
      'file-priv-again',
    ]);
  });

  it('counts_facts_and_citing_answers per copy, and the cited copy survives', async () => {
    await addFile('file-lean', { day: 5 });
    await addFile('file-rich', { day: 6 });

    const citedFact = await addFact('file-lean', 'The lean copy carries this one.');
    await addFact('file-rich', 'The rich copy carries this.');
    await addFact('file-rich', 'And this.');
    await addFact('file-rich', 'And a third.');

    // Two answers cite the LEAN copy, none the rich one.
    await addAnswer(citedFact);
    await addAnswer(citedFact);
    // A user typing the same token is not a citation: only what the assistant
    // stored is an answer whose provenance can break.
    await addAnswer(citedFact, 'user');

    const group = await groupFor(HASH);
    const byName = new Map(
      (group?.copies ?? []).map((copy) => [copy.objectKey.split('/').pop()!, copy]),
    );
    expect(byName.get('file-lean')).toMatchObject({ facts: 1, citedByAnswers: 2 });
    expect(byName.get('file-rich')).toMatchObject({ facts: 3, citedByAnswers: 0 });

    // The rule over those numbers: the cited copy stays even though the other
    // holds three times the facts, and the group is then free to tidy.
    const plan = planFor(group!);
    expect(plan.keep.objectKey.split('/').pop()).toBe('file-lean');
    expect(plan.remove.map((copy) => copy.objectKey.split('/').pop())).toEqual(['file-rich']);
    expect(plan.answersRedacted).toBe(0);
    expect(partitionPlans([plan], false).safe).toEqual([plan]);
  });

  it('holds back a group whose other copy is ALSO cited', async () => {
    // The case with no good answer: both copies carry citations, so whichever
    // survives, some stored answer loses its source.
    const both = 'd'.repeat(64);
    await addFile('file-both-a', { checksum: both, day: 7 });
    await addFile('file-both-b', { checksum: both, day: 8 });
    await addAnswer(await addFact('file-both-a', 'Cited from A.'));
    await addAnswer(await addFact('file-both-b', 'Cited from B.'));

    const plan = planFor((await groupFor(both))!);
    expect(plan.answersRedacted).toBeGreaterThan(0);
    expect(partitionPlans([plan], false).held).toEqual([plan]);
    // And only an explicit instruction includes it.
    expect(partitionPlans([plan], true).safe).toEqual([plan]);
  });
});
