import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { MemoryStore } from '../memory/index';
import type { NewFact } from '../memory/index';
import { ProjectStore } from './persistence/project.store';
import { ProjectService } from './project.service';
import { ProjectPolicySource } from './project-policy.adapter';
import { ProjectAssignmentCascade } from './projects.module';

/**
 * Projects as workspaces (V2.5 item 8.3), the properties that matter, against
 * real Postgres. The decision record (docs/features/projects.md) names each
 * of these; this file is what makes them more than prose.
 *
 * - lens_narrows_and_shares: two projects with OVERLAPPING subject matter.
 *   The same question inside each answers from that project's sources, and
 *   the underlying memory is unchanged and fully visible outside the lens.
 * - projects_inert: with no project anywhere, every read is byte-identical
 *   to the unlensed read. A user who ignores projects notices nothing.
 * - lens_is_not_a_gate: a lensed read is a strict SUBSET of the gated read,
 *   and the gates decide the same rows either way.
 * - one_project_per_thing: the uniqueness rule is a constraint.
 * - delete_keeps_contents: deleting the project leaves its sources intact
 *   and unassigned, and mints no receipt because nothing was erased.
 * - archive_keeps_everything: archiving moves one boolean.
 * - cascade_releases_the_assignment: erasing a source takes it out of its
 *   project inside the saga's transaction.
 * - project_policy_folds_in: the extraction policy is three numbers, and an
 *   unconfigured project has no opinion at all.
 *
 * Pure Postgres: the lens is a WHERE clause in the SQL arms, which is where
 * its exactness lives; the Qdrant pre-filter is only a narrowing on top.
 */

const owner: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};
const other: Principal = { ...owner, userId: 'user-b', name: 'User B' };

describe('projects as workspaces (integration, real Postgres)', () => {
  let tdb: TestDatabase;
  let memory: MemoryStore;
  let store: ProjectStore;
  let projects: ProjectService;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    memory = new MemoryStore(tdb.db); // no Qdrant: the SQL arms are the point
    store = new ProjectStore(tdb.db);
    projects = new ProjectService(tdb.db, store);
  }, 180_000);
  afterAll(async () => {
    await tdb.stop();
  });

  const fact = (content: string, sourceId: string, over: Partial<NewFact> = {}): NewFact => ({
    content,
    scope: 'private',
    sourceType: 'user_note',
    sourceId,
    ...over,
  });

  const refsFor = (...sourceIds: string[]) =>
    sourceIds.map((sourceId) => ({ sourceType: 'user_note', sourceId }));

  it('lens_narrows_and_shares: the same question answers per project, and memory stays whole', async () => {
    // Two clients, overlapping subject matter: both have a delivery date for
    // "the Arkona frame", and the numbers differ.
    const aDoc = 'note-lens-client-a';
    const bDoc = 'note-lens-client-b';
    const aFact = await memory.createFromFact(
      owner,
      fact('The Arkona frame ships on 12 March 2026', aDoc, { entities: ['Arkona'] }),
    );
    const bFact = await memory.createFromFact(
      owner,
      fact('The Arkona frame ships on 4 September 2026', bDoc, { entities: ['Arkona'] }),
    );

    const clientA = await projects.create(owner, { name: 'Client A' });
    const clientB = await projects.create(owner, { name: 'Client B' });
    await projects.assign(owner, { kind: 'source', refType: 'user_note', refId: aDoc }, clientA.id);
    await projects.assign(owner, { kind: 'source', refType: 'user_note', refId: bDoc }, clientB.id);

    const search = async (sourceRefs?: { sourceType: string; sourceId: string }[]) =>
      (await memory.ftsSearch(owner, 'Arkona frame ships', { topK: 20, sourceRefs })).map(
        (hit) => hit.memory.id,
      );

    // Inside each lens: that client's answer, and only that one.
    expect(await search(await projects.sourceRefsFor(clientA.id))).toEqual([aFact.id]);
    expect(await search(await projects.sourceRefsFor(clientB.id))).toEqual([bFact.id]);

    // Outside any lens: memory is WHOLE. Nothing was fragmented, nothing was
    // hidden, and both facts are the same rows they always were.
    const everything = await search();
    expect(everything).toContain(aFact.id);
    expect(everything).toContain(bFact.id);
  });

  it('projects_inert: with no project anywhere, the read is the unlensed read', async () => {
    const loose = 'note-inert';
    const row = await memory.createFromFact(owner, fact('Ivan prefers morning reviews', loose));
    // No assignment exists for this source: `undefined` is no lens at all.
    const withoutLens = await memory.ftsSearch(owner, 'morning reviews', { topK: 20 });
    const explicitlyUndefined = await memory.ftsSearch(owner, 'morning reviews', {
      topK: 20,
      sourceRefs: undefined,
    });
    expect(withoutLens.map((h) => h.memory.id)).toContain(row.id);
    expect(explicitlyUndefined.map((h) => h.memory.id)).toEqual(
      withoutLens.map((h) => h.memory.id),
    );
    // And the lens resolution short-circuits: an unassigned conversation has
    // no project, so nothing is computed and nothing is applied.
    expect(await projects.lensForConversation(owner, '00000000-0000-4000-8000-0000000000ff')).toBe(
      null,
    );
  });

  it('lens_is_not_a_gate: a lensed read is a strict subset of the gated read', async () => {
    const mine = 'note-gate-mine';
    const theirsShared = 'note-gate-shared';
    const theirsPrivate = 'note-gate-private';
    const content = 'The Vela order was confirmed';
    const mineRow = await memory.createFromFact(owner, fact(content, mine));
    const sharedRow = await memory.createFromFact(
      other,
      fact(content, theirsShared, { scope: 'shared' }),
    );
    const privateRow = await memory.createFromFact(other, fact(content, theirsPrivate));

    // A lens naming ALL THREE sources cannot widen past the gates: the other
    // user's private row stays invisible, exactly as it is unlensed.
    const lensed = (
      await memory.ftsSearch(owner, 'Vela order confirmed', {
        topK: 20,
        sourceRefs: refsFor(mine, theirsShared, theirsPrivate),
      })
    ).map((hit) => hit.memory.id);
    expect(lensed).toContain(mineRow.id);
    expect(lensed).toContain(sharedRow.id);
    expect(lensed).not.toContain(privateRow.id);

    // An EMPTY lens is a project with no sources: it matches nothing, which
    // is a true answer, not a widening.
    expect(
      await memory.ftsSearch(owner, 'Vela order confirmed', { topK: 20, sourceRefs: [] }),
    ).toEqual([]);
  });

  it('one_project_per_thing: assignment moves rather than accumulating', async () => {
    const doc = 'note-one-project';
    const first = await projects.create(owner, { name: 'First folder' });
    const second = await projects.create(owner, { name: 'Second folder' });
    const ref = { kind: 'source' as const, refType: 'user_note', refId: doc };
    await projects.assign(owner, ref, first.id);
    await projects.assign(owner, ref, second.id);
    expect(await store.sourceRefsFor(first.id, 100)).toEqual([]);
    expect(await store.sourceRefsFor(second.id, 100)).toEqual([
      { sourceType: 'user_note', sourceId: doc },
    ]);
    // Unassigning is the same call in the other direction.
    await projects.assign(owner, ref, null);
    expect(await store.sourceRefsFor(second.id, 100)).toEqual([]);
  });

  it('delete_keeps_contents: the folder goes, its sources stay and become unassigned', async () => {
    const doc = 'note-delete-keeps';
    const row = await memory.createFromFact(owner, fact('A quoted price of 4200 EUR', doc));
    const folder = await projects.create(owner, { name: 'Doomed folder' });
    await projects.assign(owner, { kind: 'source', refType: 'user_note', refId: doc }, folder.id);

    const outcome = await projects.delete(owner, folder.id);
    expect(outcome.released).toBe(1);

    // The source's facts are untouched: same row, same status, still found.
    const survivor = await memory.getForPrincipal(owner, row.id);
    expect(survivor?.id).toBe(row.id);
    expect(survivor?.status).toBe('active');
    expect(
      (await memory.ftsSearch(owner, 'quoted price', { topK: 20 })).map((h) => h.memory.id),
    ).toContain(row.id);
    // And it is unassigned, not orphaned into a dangling project.
    expect(await store.projectByRef('user_note', doc)).toBe(null);
    // No receipt: nothing derived from a source was destroyed, so no saga ran.
    expect(await memory.confirmedReceiptsForOwner(owner.userId)).toEqual([]);
  });

  it('archive_keeps_everything: archiving moves one boolean and keeps the assignments', async () => {
    const doc = 'note-archive';
    const folder = await projects.create(owner, { name: 'Quiet folder' });
    await projects.assign(owner, { kind: 'source', refType: 'user_note', refId: doc }, folder.id);
    const archived = await projects.setArchived(owner, folder.id, true);
    expect(archived.archived).toBe(true);
    expect(await store.sourceRefsFor(folder.id, 100)).toHaveLength(1);
    expect((await projects.list(owner, { archived: false })).map((p) => p.id)).not.toContain(
      folder.id,
    );
  });

  it('cascade_releases_the_assignment: erasing a source takes it out of its project', async () => {
    const doc = 'note-cascade';
    const folder = await projects.create(owner, { name: 'Cascade folder' });
    await projects.assign(owner, { kind: 'source', refType: 'user_note', refId: doc }, folder.id);
    const cascade = new ProjectAssignmentCascade(store);
    // No memories key on it, so the memory arm is deliberately zero.
    expect(await cascade.cascadeForMemories()).toBe(0);
    const released = await tdb.db.transaction((tx) =>
      cascade.cascadeForSource(tx, 'user_note', doc),
    );
    expect(released).toBe(1);
    expect(await store.projectByRef('user_note', doc)).toBe(null);
  });

  it('project_policy_folds_in: configured numbers reach the port, an unconfigured project has none', async () => {
    const policy = new ProjectPolicySource(store);
    const doc = 'note-policy';
    const folder = await projects.create(owner, { name: 'Policy folder' });
    await projects.assign(owner, { kind: 'source', refType: 'user_note', refId: doc }, folder.id);
    // Nothing configured: no opinion, which is the pre-feature path exactly.
    expect(await policy.policyForSource('user_note', doc)).toBe(null);
    // A source in NO project: also no opinion.
    expect(await policy.policyForSource('user_note', 'note-unassigned')).toBe(null);

    await projects.update(owner, folder.id, {
      extraction: { enabled: false, factBudget: 12, retentionDays: 90 },
    });
    expect(await policy.policyForSource('user_note', doc)).toEqual({
      enabled: false,
      factBudget: 12,
      retentionDays: 90,
    });
  });

  it('report_scope_enumerates_only_the_project: a client report cannot carry another client', async () => {
    // The findings report's project scope IS this enumeration (V2.5 item 8.3
    // issue C2): the assembler takes `sourceRefsFor` and walks nothing else,
    // so "a client-facing report contains that client's documents and no
    // others" is a property of this function rather than of a user's care.
    const clientA = await projects.create(owner, { name: 'Report client A' });
    const clientB = await projects.create(owner, { name: 'Report client B' });
    await projects.assign(
      owner,
      { kind: 'source', refType: 'user_note', refId: 'note-report-a1' },
      clientA.id,
    );
    await projects.assign(
      owner,
      { kind: 'source', refType: 'file', refId: 'org/user-a/private/file-report-a2' },
      clientA.id,
    );
    await projects.assign(
      owner,
      { kind: 'source', refType: 'user_note', refId: 'note-report-b1' },
      clientB.id,
    );
    // A conversation in the same project is NOT a source and never enters a
    // report's scope: the enumeration asks for `source` assignments only.
    await projects.assign(
      owner,
      { kind: 'conversation', refType: 'chat_conversation', refId: 'note-report-conv' },
      clientA.id,
    );

    const scoped = await projects.sourceRefsFor(clientA.id);
    expect(scoped.map((ref) => ref.sourceId).sort()).toEqual([
      'note-report-a1',
      'org/user-a/private/file-report-a2',
    ]);
    expect(scoped.map((ref) => ref.sourceId)).not.toContain('note-report-b1');
  });

  it('projects_are_per_user: another user cannot read, move or delete one', async () => {
    const folder = await projects.create(owner, { name: 'Private folder' });
    await expect(projects.get(other, folder.id)).rejects.toThrow(/not found/);
    await expect(projects.delete(other, folder.id)).rejects.toThrow(/not found/);
    await expect(
      projects.assign(other, { kind: 'source', refType: 'user_note', refId: 'x' }, folder.id),
    ).rejects.toThrow(/not found/);
  });

  it('duplicate_name_refused: one folder per name per owner', async () => {
    await projects.create(owner, { name: 'Unique folder' });
    await expect(projects.create(owner, { name: 'unique folder' })).rejects.toThrow(
      /already have a project/,
    );
    // Another user may use the same name: the constraint is per owner.
    await expect(projects.create(other, { name: 'Unique folder' })).resolves.toBeTruthy();
  });
});
