import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { laterFateOf } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore } from './factory';
import type { MemoryStore, NewFact } from './memory.store';
import { isPastBelief } from './domain/interval';
import { TimelineService } from './timeline.service';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';

const principalFor = (userId: string): Principal => ({
  userId,
  name: 'Timeline Tester',
  email: null,
  orgId: 'org-timeline',
  orgName: 'org-timeline',
  roles: [],
});

/**
 * The time-travel read composition (decision 0012) against a real supersession
 * chain. The service invents nothing — it shapes MemoryStore's gated primitives
 * — so these tests pin the visible contract: ordered spans with successors and
 * sources, gates that hold at every point in time, a correct diff, and parity
 * with the primitive chat's temporal answer uses.
 */
describe('timeline assembly (integration, real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let timeline: TimelineService;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    });
    timeline = new TimelineService(store);
    await store.ensureIndexReady();
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const seed = (owner: string, content: string, opts: Partial<NewFact> = {}) =>
    store.createFromFact(principalFor(owner), {
      content,
      scope: opts.scope ?? 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      entities: opts.entities ?? ['Atlas'],
      subjectEntity: opts.subjectEntity ?? 'Atlas',
      sensitive: opts.sensitive,
      validFrom: opts.validFrom,
      validUntil: opts.validUntil,
      initialStatus: opts.initialStatus,
    });

  /** A subject with a price supersession (Jan → Apr) plus a stable launch fact. */
  const seedAtlas = async (owner: string) => {
    const v1 = await seed(owner, 'Atlas costs 100 EUR.', { validFrom: new Date('2026-01-01') });
    const { successor: v2 } = await store.supersede({ kind: 'user', userId: owner }, v1.id, {
      content: 'Atlas costs 120 EUR.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      entities: ['Atlas'],
      subjectEntity: 'Atlas',
      validFrom: new Date('2026-04-01'),
    });
    const launched = await seed(owner, 'Atlas launched in 2025.', {
      validFrom: new Date('2025-06-01'),
    });
    return { v1, v2, launched };
  };

  it('timeline_assembly: ordered spans carry successors and sources for a supersession chain', async () => {
    const owner = `tl-assembly-${randomUUID()}`;
    const { v1, v2, launched } = await seedAtlas(owner);

    const { subject, spans } = await timeline.forSubject(principalFor(owner), 'Atlas');
    expect(subject).toBe('Atlas');

    // Newest effective-from first: v2 (Apr 2026) → v1 (Jan 2026) → launched (2025).
    expect(spans.map((s) => s.memory.id)).toEqual([v2.id, v1.id, launched.id]);

    const spanV1 = spans.find((s) => s.memory.id === v1.id)!;
    const spanV2 = spans.find((s) => s.memory.id === v2.id)!;

    // The superseded fact links to its successor and reads as past; the current
    // one is visually distinct (current true, not past).
    expect(spanV1.supersededBy).toBe(v2.id);
    expect(spanV1.pastBelief).toBe(true);
    expect(spanV1.current).toBe(false);
    expect(spanV1.effectiveUntil).toBe(new Date('2026-04-01').toISOString());
    expect(spanV2.current).toBe(true);
    expect(spanV2.pastBelief).toBe(false);
    expect(spanV2.effectiveUntil).toBeNull();

    // The causing source is one click away for every state (provenance present).
    for (const span of spans) {
      expect(span.memory.sourceType).toBe('user_note');
      expect(span.memory.sourceId).toBeTruthy();
    }
  });

  it('point_in_time_view_gated: no other user’s private or sensitive fact at any instant', async () => {
    const ownerA = `tl-gate-a-${randomUUID()}`;
    const ownerB = `tl-gate-b-${randomUUID()}`;
    await seedAtlas(ownerA);
    const mineSensitive = await seed(ownerA, 'Atlas has a secret discount.', {
      validFrom: new Date('2026-01-01'),
      sensitive: true,
    });
    const theirPrivate = await seed(ownerB, 'Atlas (their private note).', {
      validFrom: new Date('2026-01-01'),
    });
    const theirSensitive = await seed(ownerB, 'Atlas (their sensitive note).', {
      validFrom: new Date('2026-01-01'),
      sensitive: true,
    });

    // Two instants: March (v1 era) and May (v2 era). The gates hold at both.
    for (const at of [new Date('2026-03-15'), new Date('2026-05-15')]) {
      const view = await timeline.pointInTime(principalFor(ownerA), 'Atlas', at);
      const ids = view.facts.map((f) => f.memory.id);
      expect(ids).not.toContain(theirPrivate.id); // scope gate holds through time
      expect(ids).not.toContain(theirSensitive.id); // sensitive gate holds through time
      expect(ids).toContain(mineSensitive.id); // owner’s own sensitive: opted in
    }

    // ownerB never sees ownerA’s sensitive fact, at any instant.
    const asB = await timeline.pointInTime(principalFor(ownerB), 'Atlas', new Date('2026-03-15'));
    expect(asB.facts.map((f) => f.memory.id)).not.toContain(mineSensitive.id);
  });

  it('diff_between_points: added / changed / removed / unchanged are correct end to end', async () => {
    const owner = `tl-diff-${randomUUID()}`;
    const { v1, v2, launched } = await seedAtlas(owner);
    // A fact that only exists after the window opens — a genuine addition.
    const added = await seed(owner, 'Atlas moved to Berlin.', {
      validFrom: new Date('2026-05-01'),
    });

    const diff = await timeline.diff(
      principalFor(owner),
      'Atlas',
      new Date('2026-02-01'), // v1 era
      new Date('2026-06-01'), // v2 era
    );

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.before.id).toBe(v1.id);
    expect(diff.changed[0]!.after.id).toBe(v2.id);
    expect(diff.unchanged.map((m) => m.id)).toContain(launched.id);
    expect(diff.added.map((m) => m.id)).toContain(added.id);
    // The successor of a change is not also reported as an addition.
    expect(diff.added.map((m) => m.id)).not.toContain(v2.id);
    expect(diff.removed).toHaveLength(0);
  });

  it('ui_matches_chat: the timeline point-in-time is the same primitive chat answers from', async () => {
    const owner = `tl-parity-${randomUUID()}`;
    const { v1, v2 } = await seedAtlas(owner);
    const at = new Date('2026-03-15');

    // The primitive a temporal chat answer retrieves through (RetrievalService
    // .temporalRetrieve → store.pointInTime), embedding included as chat does.
    const chatHits = await store.pointInTime(principalFor(owner), at, {
      topK: 200,
      entities: ['Atlas'],
      includeSensitive: true,
      embedding: fakeEmbedding('atlas price', DIMS),
    });
    const view = await timeline.pointInTime(principalFor(owner), 'Atlas', at);

    // Same facts (the timeline is a projection of that gated primitive, not a
    // reimplementation): the March belief v1, framed as past, in both.
    const chatIds = new Set(chatHits.map((h) => h.memory.id));
    const uiIds = new Set(view.facts.map((f) => f.memory.id));
    expect(uiIds).toEqual(chatIds);
    expect(uiIds).toContain(v1.id);
    expect(uiIds).not.toContain(v2.id); // the April successor did not hold in March

    // The past-framing contract agrees across the two views (ruling 6): the same
    // row is past belief for chat (isPastBelief) and 'replaced' for the UI label.
    const v1Row = chatHits.find((h) => h.memory.id === v1.id)!.memory;
    const v1Fact = view.facts.find((f) => f.memory.id === v1.id)!;
    expect(isPastBelief(v1Row)).toBe(true);
    expect(laterFateOf(v1Fact.memory)).toBe('replaced');
    expect(v1Fact.supersededBy).toBe(v2.id);
  });
});
