import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore } from './factory';
import type { MemoryStore, NewFact } from './memory.store';
import { intervalHoldsAt, intervalHoldsAtSql } from './domain/interval';
import { memory } from './persistence/tables';
import { and, inArray } from 'drizzle-orm';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';

const principalFor = (userId: string): Principal => ({
  userId,
  name: 'Temporal Tester',
  email: null,
  orgId: 'org-temporal',
  orgName: 'org-temporal',
  roles: [],
});

describe('temporal primitives (integration, real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    });
    await store.ensureIndexReady();
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const seed = async (
    owner: string,
    content: string,
    opts: Partial<NewFact> & { createdAt?: string } = {},
  ) => {
    const row = await store.createFromFact(principalFor(owner), {
      content,
      scope: 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      entities: opts.entities ?? [],
      sensitive: opts.sensitive,
      validFrom: opts.validFrom,
      validUntil: opts.validUntil,
      initialStatus: opts.initialStatus,
    });
    if (opts.createdAt) {
      await tdb.pool.query(`UPDATE memory SET created_at = $2 WHERE id = $1`, [
        row.id,
        opts.createdAt,
      ]);
      return { ...row, createdAt: new Date(opts.createdAt) };
    }
    return row;
  };

  it('interval_predicate_matrix: the shared helper against a truth table — SQL and TS twins agree', async () => {
    const owner = `t-matrix-${randomUUID()}`;
    const t = new Date('2026-06-15T00:00:00Z');
    // [description, valid_from, valid_until, created_at, holds at t?]
    const matrix: [string, string | null, string | null, string, boolean][] = [
      ['open interval, started before t', '2026-06-01', null, '2026-05-01', true],
      ['starts exactly AT t (half-open lower: closed)', '2026-06-15', null, '2026-05-01', true],
      ['starts after t', '2026-06-16', null, '2026-05-01', false],
      [
        'ends exactly AT t (half-open upper: open)',
        '2026-06-01',
        '2026-06-15',
        '2026-05-01',
        false,
      ],
      ['ends just after t', '2026-06-01', '2026-06-16', '2026-05-01', true],
      ['NULL from, created before t, still holding', null, null, '2026-06-10', true],
      ['NULL from, created after t', null, null, '2026-06-16', false],
      ['NULL from, created before t, ended before t', null, '2026-06-12', '2026-06-10', false],
      ['closed entirely before t', '2026-06-10', '2026-06-11', '2026-05-01', false],
      ['ends at exactly created_at boundary case', null, '2026-06-15', '2026-06-15', false],
    ];

    const ids: string[] = [];
    const expectations = new Map<string, { holds: boolean; label: string }>();
    for (const [label, from, until, createdAt] of matrix) {
      const row = await seed(owner, `matrix: ${label}`, {
        validFrom: from ? new Date(from) : undefined,
        validUntil: until ? new Date(until) : undefined,
        createdAt,
      });
      // The aggregate defaults valid_from to now (S2 admission); a true NULL
      // exists only on legacy rows — force it so the fallback arm is tested.
      if (!from) {
        await tdb.pool.query(`UPDATE memory SET valid_from = NULL WHERE id = $1`, [row.id]);
      }
      ids.push(row.id);
      const [, , , , holds] = matrix.find(([l]) => l === label)!;
      expectations.set(row.id, { holds, label });

      // The pure TS twin must agree with the declared truth.
      expect(
        intervalHoldsAt(
          {
            validFrom: from ? new Date(from) : null,
            validUntil: until ? new Date(until) : null,
            createdAt: new Date(createdAt),
          },
          t,
        ),
        `TS twin: ${label}`,
      ).toBe(holds);
    }

    // The SQL fragment must select exactly the holding rows.
    const rows = await tdb.db
      .select({ id: memory.id })
      .from(memory)
      .where(and(inArray(memory.id, ids), intervalHoldsAtSql(t)));
    const held = new Set(rows.map((r) => r.id));
    for (const [id, { holds, label }] of expectations) {
      expect(held.has(id), `SQL fragment: ${label}`).toBe(holds);
    }
  });

  it('point_in_time_gated: scope and sensitive hold in temporal mode — no leaks through time', async () => {
    const ownerA = `t-gate-a-${randomUUID()}`;
    const ownerB = `t-gate-b-${randomUUID()}`;
    const t = new Date('2026-04-15T00:00:00Z');

    const mine = await seed(ownerA, 'A plain fact that held in April.', {
      validFrom: new Date('2026-04-01'),
    });
    const mineSensitive = await seed(ownerA, 'A sensitive fact that held in April.', {
      validFrom: new Date('2026-04-01'),
      sensitive: true,
    });
    const theirs = await seed(ownerB, 'Another user’s fact that held in April.', {
      validFrom: new Date('2026-04-01'),
    });

    const defaults = await store.pointInTime(principalFor(ownerA), t, { topK: 20 });
    const defaultIds = defaults.map((h) => h.memory.id);
    expect(defaultIds).toContain(mine.id);
    expect(defaultIds).not.toContain(theirs.id); // scope gate holds through time
    expect(defaultIds).not.toContain(mineSensitive.id); // sensitive needs opt-in

    const optIn = await store.pointInTime(principalFor(ownerA), t, {
      topK: 20,
      includeSensitive: true,
    });
    expect(optIn.map((h) => h.memory.id)).toContain(mineSensitive.id);
    const asB = await store.pointInTime(principalFor(ownerB), t, {
      topK: 20,
      includeSensitive: true,
    });
    expect(asB.map((h) => h.memory.id)).not.toContain(mineSensitive.id); // owner-only even opted in

    // Lifecycle statuses are INCLUDED: supersede the plain fact; at t the
    // predecessor held, and it returns with its CURRENT status and pointer.
    const { successor } = await store.supersede({ kind: 'user', userId: ownerA }, mine.id, {
      content: 'The plain fact, updated in June.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      validFrom: new Date('2026-06-01'),
    });
    const after = await store.pointInTime(principalFor(ownerA), t, { topK: 20 });
    const replayed = after.find((h) => h.memory.id === mine.id);
    expect(replayed).toBeDefined();
    expect(replayed!.memory.status).toBe('replaced');
    expect(replayed!.memory.supersededBy).toBe(successor.id);
    // The June successor did NOT hold in April.
    expect(after.map((h) => h.memory.id)).not.toContain(successor.id);
  });

  it('changes_since_events: seeded transitions return exactly the ruled event set', async () => {
    const owner = `t-changes-${randomUUID()}`;
    const other = `t-changes-other-${randomUUID()}`;
    const since = new Date(Date.now() - 60_000);

    const learned = await seed(owner, 'A fact learned this window.');
    const approved = await seed(owner, 'An uncertain fact the user approves.', {
      initialStatus: 'uncertain',
    });
    await store.transition({ kind: 'user', userId: owner }, approved.id, 'user_approved', 'review');
    const dated = await seed(owner, 'A fact the user marks outdated.');
    await store.transition({ kind: 'user', userId: owner }, dated.id, 'outdated', 'stale');
    const edited = await seed(owner, 'A fact the user edits.');
    const { successor } = await store.editContent(
      principalFor(owner),
      edited.id,
      'A fact the user edited.',
    );
    await seed(other, 'Another owner’s fact — invisible.');
    await store.transition(
      { kind: 'user', userId: other },
      (await seed(other, 'x')).id,
      'outdated',
    );

    const events = await store.changesSince(principalFor(owner), since);
    const byKind = (kind: string) => events.filter((e) => e.kind === kind);

    // learned: the four seeds + the edit successor — never the other owner's.
    const learnedIds = byKind('learned').map((e) => e.memory.id);
    expect(learnedIds).toEqual(
      expect.arrayContaining([learned.id, approved.id, dated.id, edited.id, successor.id]),
    );
    expect(events.some((e) => e.memory.ownerId === other)).toBe(false);

    // status_changed: exactly the two user transitions.
    const transitions = byKind('status_changed').map((e) => ({
      id: e.memory.id,
      to: e.detail.to,
    }));
    expect(transitions).toEqual(
      expect.arrayContaining([
        { id: approved.id, to: 'user_approved' },
        { id: dated.id, to: 'outdated' },
      ]),
    );
    expect(byKind('status_changed')).toHaveLength(2);

    // superseded: the edit, pointing at its successor.
    const superseded = byKind('superseded');
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.memory.id).toBe(edited.id);
    expect(superseded[0]!.detail.supersededBy).toBe(successor.id);

    // Newest first.
    const times = events.map((e) => e.at.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('temporal ranking stays within the temporal candidate set', async () => {
    const owner = `t-rank-${randomUUID()}`;
    const t = new Date('2026-03-15T00:00:00Z');
    const inMarch = await seed(owner, 'The CRM in March was HubSpot.', {
      validFrom: new Date('2026-01-10'),
      validUntil: new Date('2026-04-01'),
    });
    const afterMarch = await seed(owner, 'The CRM since April is Atlas.', {
      validFrom: new Date('2026-04-01'),
    });
    await store.upsertVectors(
      [inMarch, afterMarch].map((r) => ({ ...r })),
      [fakeEmbedding('crm march', DIMS), fakeEmbedding('crm april', DIMS)],
    );
    const hits = await store.pointInTime(principalFor(owner), t, {
      topK: 10,
      embedding: fakeEmbedding('crm march', DIMS),
    });
    const ids = hits.map((h) => h.memory.id);
    expect(ids).toContain(inMarch.id);
    expect(ids).not.toContain(afterMarch.id); // relevance can never widen the set
  });
});
