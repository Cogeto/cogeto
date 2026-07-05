import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { ModelGateway } from '../model-gateway/index';
import { MemoryStore } from './memory.store';
import type { NewFact } from './memory.store';
import { runMemoryEmbedJob } from './embed-job';
import { MemoryVectorStore } from './persistence/vector-store';
import type { MemoryPointPayload } from './persistence/vector-store';

/**
 * The S3-B named governance tests: edit_supersession, review_transitions,
 * sensitive_toggle_two_store, actions_audited, illegal_action_guarded.
 * Real Postgres + real Qdrant; embeddings faked at the seam.
 */

const DIMS = 8;
const MODEL = 'test-embed';

const userA: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};
const userB: Principal = { ...userA, userId: 'user-b', name: 'User B' };

class FakeEmbedGateway extends ModelGateway {
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used
  async *completeStream(): AsyncIterable<string> {
    throw new Error('not used');
  }
  extractStructured<T>(): Promise<T> {
    throw new Error('not used');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => fakeEmbedding(text, DIMS));
  }
  embeddingModelId(): string {
    return MODEL;
  }
}

/** Fails setPayload exactly once — the simulated crash between the two stores. */
class FlakyVectorStore extends MemoryVectorStore {
  failNextSetPayload = false;
  override async setPayload(id: string, payload: Partial<MemoryPointPayload>): Promise<void> {
    if (this.failNextSetPayload) {
      this.failNextSetPayload = false;
      throw new Error('simulated Qdrant outage between the two stores');
    }
    return super.setPayload(id, payload);
  }
}

describe('memory governance (integration, real Postgres + real Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let vectors: FlakyVectorStore;
  let store: MemoryStore;
  const gateway = new FakeEmbedGateway();

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    vectors = new FlakyVectorStore({
      url: qdrant.url,
      embeddingModel: MODEL,
      dimensions: DIMS,
    });
    store = new MemoryStore(tdb.db, vectors);
    await store.ensureIndexReady();
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const fact = (content: string, overrides: Partial<NewFact> = {}): NewFact => ({
    content,
    scope: 'private',
    sourceType: 'user_note',
    sourceId: `note-${Math.random().toString(36).slice(2)}`,
    embeddingModel: MODEL,
    ...overrides,
  });

  const seedIndexed = async (principal: Principal, newFact: NewFact) => {
    const row = await store.createFromFact(principal, newFact);
    await store.upsertVectors([row], [fakeEmbedding(row.content as string, DIMS)]);
    return row;
  };

  const auditCount = async (action: string, entityId: string, actor: string) => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND entity_id = $2 AND actor = $3',
      [action, entityId, actor],
    );
    return Number(rows[0]!.n);
  };

  it('edit_supersession: successor user_approved, predecessor replaced with closed interval; history never mutates', async () => {
    const original = await seedIndexed(userA, fact('Maja owes the Q2 figures by Friday'));

    const { predecessor, successor } = await store.editContent(
      userA,
      original.id,
      'Maja owes the Q2 AND Q3 figures by Friday',
    );

    expect(successor.status).toBe('user_approved');
    expect(successor.content).toBe('Maja owes the Q2 AND Q3 figures by Friday');
    // Same provenance — an edit does not orphan the fact (§A.6, 0006 ruling 3).
    expect(successor.sourceType).toBe(original.sourceType);
    expect(successor.sourceId).toBe(original.sourceId);
    expect(predecessor.status).toBe('replaced');
    expect(predecessor.supersededBy).toBe(successor.id);
    expect(predecessor.validUntil).not.toBeNull();
    // The old content never mutates.
    expect(predecessor.content).toBe('Maja owes the Q2 figures by Friday');

    // The chain endpoint's backing read: full chain, oldest → newest, from
    // either end.
    const fromOld = await store.getChain(userA, original.id);
    const fromNew = await store.getChain(userA, successor.id);
    expect(fromOld.map((m) => m.id)).toEqual([original.id, successor.id]);
    expect(fromNew.map((m) => m.id)).toEqual([original.id, successor.id]);

    // The successor's embedding arrives via the outbox-enqueued worker job.
    const { rows } = await tdb.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE task_identifier = 'memory.embed'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
    await tdb.db.transaction((tx) =>
      runMemoryEmbedJob(tx, store, gateway, { source_id: successor.id }),
    );
    const vecs = await vectors.retrieveVectors([successor.id]);
    expect(vecs.has(successor.id)).toBe(true);
    // The predecessor's payload copy tells the truth too (§A.4).
    const payloads = await vectors.retrievePayloads([predecessor.id]);
    expect(payloads.get(predecessor.id)?.status).toBe('replaced');

    // A second edit of the replaced predecessor is refused — edit the successor.
    await expect(store.editContent(userA, original.id, 'no')).rejects.toThrow(BadRequestException);
  });

  it('review_transitions: approve uncertain→user_approved (owner); reject only from uncertain, removing row AND point', async () => {
    const uncertainA = await seedIndexed(
      userA,
      fact('Vedran probably wants the summary', { initialStatus: 'uncertain' }),
    );

    // Approve — owner only; audited.
    const approved = await store.transition(
      { kind: 'user', userId: userA.userId },
      uncertainA.id,
      'user_approved',
      'review',
    );
    expect(approved.status).toBe('user_approved');
    expect(await auditCount('memory.status_transition', uncertainA.id, 'user:user-a')).toBe(1);
    const approvedPayload = await vectors.retrievePayloads([uncertainA.id]);
    expect(approvedPayload.get(uncertainA.id)?.status).toBe('user_approved');

    // A non-owner cannot approve someone else's uncertain memory.
    const uncertainA2 = await seedIndexed(
      userA,
      fact('Another uncertain fact', { initialStatus: 'uncertain' }),
    );
    await expect(
      store.transition({ kind: 'user', userId: userB.userId }, uncertainA2.id, 'user_approved'),
    ).rejects.toThrow(NotFoundException);

    // Reject — removes row and point, audited (0006 ruling 4).
    const rejected = await store.rejectUncertain(userA, uncertainA2.id);
    expect(rejected?.id).toBe(uncertainA2.id);
    expect(await store.getForPrincipal(userA, uncertainA2.id)).toBeNull();
    expect((await vectors.retrieveVectors([uncertainA2.id])).size).toBe(0);
    expect(await auditCount('memory.rejected', uncertainA2.id, 'user:user-a')).toBe(1);
    // Second rejection: nothing left to remove.
    expect(await store.rejectUncertain(userA, uncertainA2.id)).toBeNull();
  });

  it('sensitive_toggle_two_store: a crash between Postgres and Qdrant converges on retry', async () => {
    const row = await seedIndexed(userA, fact('The Arkona retainer is €4,500 monthly'));

    // Crash between the stores: the transaction must roll the row back.
    vectors.failNextSetPayload = true;
    await expect(store.toggleSensitive(userA, row.id, true)).rejects.toThrow('simulated');
    const afterCrash = await store.getForPrincipal(userA, row.id, { includeSensitive: true });
    expect(afterCrash?.sensitive).toBe(false);
    const payloadAfterCrash = await vectors.retrievePayloads([row.id]);
    expect(payloadAfterCrash.get(row.id)?.sensitive).toBe(false);

    // Retry converges: row and payload agree.
    const toggled = await store.toggleSensitive(userA, row.id, true);
    expect(toggled.sensitive).toBe(true);
    const payload = await vectors.retrievePayloads([row.id]);
    expect(payload.get(row.id)?.sensitive).toBe(true);

    // And the gate is live: the sensitive row leaves default vector search.
    const hits = await store.vectorSearch(userA, fakeEmbedding(row.content as string, DIMS), {
      topK: 10,
    });
    expect(hits.map((h) => h.memoryId)).not.toContain(row.id);
  });

  it('actions_audited: every dashboard action writes exactly one audit row with the acting principal', async () => {
    const actor = 'user:user-a';

    const approveTarget = await seedIndexed(
      userA,
      fact('Audit approve target', { initialStatus: 'uncertain' }),
    );
    await store.transition(
      { kind: 'user', userId: userA.userId },
      approveTarget.id,
      'user_approved',
    );
    expect(await auditCount('memory.status_transition', approveTarget.id, actor)).toBe(1);

    const outdateTarget = await seedIndexed(userA, fact('Audit outdate target'));
    await store.transition({ kind: 'user', userId: userA.userId }, outdateTarget.id, 'outdated');
    expect(await auditCount('memory.status_transition', outdateTarget.id, actor)).toBe(1);

    const toggleTarget = await seedIndexed(userA, fact('Audit toggle target'));
    await store.toggleSensitive(userA, toggleTarget.id, true);
    expect(await auditCount('memory.sensitive_toggled', toggleTarget.id, actor)).toBe(1);
    // The idempotent no-op writes no audit noise.
    await store.toggleSensitive(userA, toggleTarget.id, true);
    expect(await auditCount('memory.sensitive_toggled', toggleTarget.id, actor)).toBe(1);

    const editTarget = await seedIndexed(userA, fact('Audit edit target'));
    await store.editContent(userA, editTarget.id, 'Audit edit target, corrected');
    expect(await auditCount('memory.edited', editTarget.id, actor)).toBe(1);

    const rejectTarget = await seedIndexed(
      userA,
      fact('Audit reject target', { initialStatus: 'uncertain' }),
    );
    await store.rejectUncertain(userA, rejectTarget.id);
    expect(await auditCount('memory.rejected', rejectTarget.id, actor)).toBe(1);
  });

  it('illegal_action_guarded: approve/reject on active and edit by a non-owner fail with typed errors', async () => {
    const active = await seedIndexed(userA, fact('An active, verified fact'));

    // Approve on active: 400 with the transition reason.
    await expect(
      store.transition({ kind: 'user', userId: userA.userId }, active.id, 'user_approved'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      store.transition({ kind: 'user', userId: userA.userId }, active.id, 'user_approved'),
    ).rejects.toThrow(/only an uncertain or contradicted memory can be approved/);

    // Reject on active: 400 pointing at the deletion saga for real deletions.
    await expect(store.rejectUncertain(userA, active.id)).rejects.toThrow(BadRequestException);
    await expect(store.rejectUncertain(userA, active.id)).rejects.toThrow(
      /only an uncertain memory can be rejected/,
    );

    // Edit by a non-owner: 404 — existence is not leaked.
    await expect(store.editContent(userB, active.id, 'hijack')).rejects.toThrow(NotFoundException);

    // And the row is untouched by all of the above.
    const after = await store.getForPrincipal(userA, active.id);
    expect(after?.status).toBe('active');
    expect(after?.content).toBe('An active, verified fact');
  });
});
