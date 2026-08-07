import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { FactKind, Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryReconciliation } from '../memory/index';
import type { MemoryReconciliation, MemoryRow, MemoryStore, NewFact } from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StreamDelta, StructuredExtractionRequest } from '../model-gateway/index';
import { ReconciliationService } from './pipeline/reconcile.stage';
import { CheckedPairStore } from './persistence/checked-pair.store';
import { EntityAliasStore } from './persistence/entity-alias.store';
import { noopLog } from './pipeline/pipeline-log';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';

/**
 * The findings lifecycle end to end (V2.3 item 6.1, issue E;
 * docs/features/findings.md), against real Postgres + Qdrant with the judge
 * scripted at the gateway seam. The six binding scenarios:
 *
 *   1. a revision that resolves a contradiction closes it, cause recorded;
 *   2. a revision that changes an unrelated fact leaves it open;
 *   3. a reintroduced conflict REOPENS the original finding, history intact;
 *   4. user resolution and revision resolution are uniformly represented;
 *   5. resolved findings never appear as current anywhere;
 *   6. (ledger) an unchanged corpus re-run changes no verdict and spends no
 *      model call — the nightly flip-flop is structurally gone.
 */

const BASE_VEC = [1, 0, 0, 0, 0, 0, 0, 0];
const MID_BAND_VEC = [0.7, Math.sqrt(1 - 0.49), 0, 0, 0, 0, 0, 0];
/** Raw cosine 0 → 0.5 normalized: far below the contradiction floor. */
const FAR_VEC = [0, 0, 1, 0, 0, 0, 0, 0];

type Judged = {
  verdict: string;
  reason: string;
  merged_content?: string | null;
  direction?: string | null;
};

/**
 * Scripted judge keyed on the PAIR's contents: `rule(bSide)` sees the FACT B
 * half of the pair input (the existing candidate) and returns the verdict for
 * that pair, so multi-candidate runs are deterministic regardless of ranking
 * order. Dedup calls always answer `distinct` — these scenarios exercise the
 * contradiction family.
 */
class PairScriptedGateway extends ModelGateway {
  contradictionCalls = 0;
  dedupCalls = 0;
  constructor(private rule: (bSide: string) => Judged) {
    super();
  }
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used by reconciliation
  async *completeStream(): AsyncIterable<StreamDelta> {
    throw new Error('not used');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return EMBED_MODEL;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const family = request.system.includes('same_fact') ? 'dedup' : 'contradiction';
    const raw: Judged =
      family === 'dedup'
        ? (this.dedupCalls++, { verdict: 'distinct', reason: 'scripted', merged_content: null })
        : (this.contradictionCalls++,
          this.rule(request.input.slice(request.input.indexOf('FACT B:'))));
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

const principalFor = (userId: string): Principal => ({
  userId,
  name: 'Lifecycle Tester',
  email: null,
  orgId: 'org-lc',
  orgName: 'org-lc',
  roles: [],
});

const compatible: Judged = { verdict: 'compatible', direction: null, reason: 'scripted ok' };

describe('findings lifecycle (integration, real Postgres + Qdrant, scripted judge)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let reconciliation: MemoryReconciliation;
  let ledger: CheckedPairStore;
  let aliases: EntityAliasStore;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    ({ store, reconciliation } = createMemoryReconciliation({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    }));
    await store.ensureIndexReady();
    ledger = new CheckedPairStore(tdb.db);
    aliases = new EntityAliasStore(tdb.db);
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const service = (gateway: PairScriptedGateway) =>
    new ReconciliationService(
      gateway,
      store,
      reconciliation,
      ledger,
      aliases,
      undefined,
      'test-provider/test-model',
    );

  const seed = async (
    owner: string,
    content: string,
    vector: number[],
    opts: Partial<NewFact> & { kind?: FactKind } = {},
  ): Promise<MemoryRow> => {
    const row = await store.createFromFact(principalFor(owner), {
      content,
      scope: 'private',
      sourceType: 'user_note',
      sourceId: opts.sourceId ?? randomUUID(),
      entities: opts.entities ?? [],
      subjectEntity: opts.subjectEntity,
      kind: opts.kind,
      validFrom: opts.validFrom,
      validUntil: opts.validUntil,
      initialStatus: opts.initialStatus,
      embeddingModel: EMBED_MODEL,
    });
    await store.upsertVectors([row], [vector]);
    return row;
  };

  const runStage6 = (
    svc: ReconciliationService,
    items: { row: MemoryRow; vector: number[] }[],
    detectedBy: 'pipeline' | 'dreaming' | 'repair' = 'pipeline',
  ) =>
    tdb.db.transaction((tx) =>
      svc.reconcile(
        tx,
        items.map(({ row, vector }) => ({ row, embedding: vector })),
        noopLog,
        { exclude: 'same_batch', detectedBy },
      ),
    );

  const relationRows = async (id: string) => {
    const { rows } = await tdb.pool.query<{
      id: string;
      a_memory_id: string;
      b_memory_id: string;
      resolved_at: Date | null;
      resolution: string | null;
      detected_by: string | null;
    }>(`SELECT * FROM memory_relation WHERE a_memory_id = $1 OR b_memory_id = $1`, [id]);
    return rows;
  };
  const eventsFor = async (relationId: string) => {
    const { rows } = await tdb.pool.query<{ event: string; detail_json: unknown }>(
      `SELECT event, detail_json FROM memory_relation_event
       WHERE relation_id = $1 ORDER BY created_at, id`,
      [relationId],
    );
    return rows;
  };
  const statusOf = async (id: string) => {
    const { rows } = await tdb.pool.query<{ status: string; superseded_by: string | null }>(
      `SELECT status, superseded_by FROM memory WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  };
  const freshOwner = (name: string) => `lc-${name}-${randomUUID()}`;

  /** Seeds an open X-vs-Y contradiction over subject S and returns everything. */
  const seedOpenFinding = async (owner: string, subject = 'Atlas Migration') => {
    const existing = await seed(owner, `${subject} go-live is September 1.`, BASE_VEC, {
      kind: 'decision',
      subjectEntity: subject,
    });
    const gateway = new PairScriptedGateway(() => ({
      verdict: 'contradicts',
      direction: null,
      reason: 'two dates for one go-live',
    }));
    const incoming = await seed(owner, `${subject} go-live is October 1.`, MID_BAND_VEC, {
      kind: 'decision',
      subjectEntity: subject,
    });
    const summary = await runStage6(service(gateway), [{ row: incoming, vector: MID_BAND_VEC }]);
    expect(summary.contradictions).toBe(1);
    const relations = await relationRows(incoming.id);
    expect(relations).toHaveLength(1);
    return { existing, incoming, relation: relations[0]! };
  };

  it('detection stamps detected_by and writes the detected event', async () => {
    const owner = freshOwner('detect');
    const { relation } = await seedOpenFinding(owner);
    expect(relation.detected_by).toBe('pipeline');
    const events = await eventsFor(relation.id);
    expect(events.map((e) => e.event)).toEqual(['detected']);
  });

  it('a revision that resolves the conflict closes the finding with the cause recorded', async () => {
    const owner = freshOwner('resolve');
    const { existing, incoming, relation } = await seedOpenFinding(owner);
    // The corrected document agrees with `existing` (September); its fact
    // supersedes the October one and is compatible with the counterpart.
    const gateway = new PairScriptedGateway((input) => {
      if (input.includes('October')) {
        return { verdict: 'supersedes', direction: 'a_over_b', reason: 'corrected date' };
      }
      return compatible;
    });
    const corrected = await seed(
      owner,
      'Atlas Migration go-live is September 1, final.',
      MID_BAND_VEC,
      {
        kind: 'decision',
        subjectEntity: 'Atlas Migration',
      },
    );
    const summary = await runStage6(service(gateway), [{ row: corrected, vector: MID_BAND_VEC }]);
    expect(summary.superseded).toBe(1);
    expect(summary.resolvedByRevision).toBe(1);

    const [after] = await relationRows(incoming.id);
    expect(after!.id).toBe(relation.id);
    expect(after!.resolved_at).not.toBeNull();
    expect(after!.resolution).toBe('revision');
    // The superseded party closed; the counterpart is restored, not left
    // wearing a warning chip for a conflict that no longer exists.
    expect((await statusOf(incoming.id)).status).toBe('replaced');
    expect((await statusOf(existing.id)).status).toBe('active');
    const events = (await eventsFor(relation.id)).map((e) => e.event);
    expect(events).toEqual(['detected', 'resolved_by_revision']);
  });

  it('a revision that changes an unrelated fact leaves the finding open', async () => {
    const owner = freshOwner('unrelated');
    const { relation } = await seedOpenFinding(owner);
    // An unrelated fact (different subject, far vector) gets superseded.
    const gateway = new PairScriptedGateway((input) =>
      input.includes('Harbour lease')
        ? { verdict: 'supersedes', direction: 'a_over_b', reason: 'updated rent' }
        : compatible,
    );
    await seed(owner, 'Harbour lease rent is 1000 EUR.', FAR_VEC, {
      kind: 'fact',
      subjectEntity: 'Harbour lease',
    });
    const update = await seed(owner, 'Harbour lease rent is 1200 EUR now.', FAR_VEC, {
      kind: 'fact',
      subjectEntity: 'Harbour lease',
    });
    await runStage6(service(gateway), [{ row: update, vector: FAR_VEC }]);
    const [after] = await relationRows(relation.a_memory_id);
    expect(after!.resolved_at).toBeNull();
    expect((await eventsFor(relation.id)).map((e) => e.event)).toEqual(['detected']);
  });

  it('a persisting conflict follows the successor instead of minting a second finding', async () => {
    const owner = freshOwner('follow');
    const { existing, incoming, relation } = await seedOpenFinding(owner);
    // The revision restates the October date: it supersedes its predecessor
    // but still conflicts with the September side.
    const gateway = new PairScriptedGateway((input) => {
      if (input.includes('October')) {
        return { verdict: 'supersedes', direction: 'a_over_b', reason: 'restated' };
      }
      return { verdict: 'contradicts', direction: null, reason: 'still two dates' };
    });
    const restated = await seed(owner, 'Atlas Migration go-live stays October 1.', MID_BAND_VEC, {
      kind: 'decision',
      subjectEntity: 'Atlas Migration',
    });
    await runStage6(service(gateway), [{ row: restated, vector: MID_BAND_VEC }]);

    const relations = await relationRows(existing.id);
    expect(relations).toHaveLength(1);
    expect(relations[0]!.id).toBe(relation.id);
    expect(relations[0]!.resolved_at).toBeNull();
    const parties = [relations[0]!.a_memory_id, relations[0]!.b_memory_id];
    expect(parties).toContain(restated.id);
    expect(parties).not.toContain(incoming.id);
    expect((await statusOf(restated.id)).status).toBe('contradicted');
    const events = (await eventsFor(relation.id)).map((e) => e.event);
    expect(events).toEqual(['detected', 'party_superseded']);
  });

  it('a reintroduced conflict reopens the original finding with its history intact', async () => {
    const owner = freshOwner('reopen');
    const { existing, incoming, relation } = await seedOpenFinding(owner);

    // Round 1: revision 2 corrects the date; the finding resolves.
    const fixGateway = new PairScriptedGateway((input) =>
      input.includes('October')
        ? { verdict: 'supersedes', direction: 'a_over_b', reason: 'corrected' }
        : compatible,
    );
    const corrected = await seed(
      owner,
      'Atlas Migration go-live is September 1, agreed.',
      MID_BAND_VEC,
      {
        kind: 'decision',
        subjectEntity: 'Atlas Migration',
      },
    );
    await runStage6(service(fixGateway), [{ row: corrected, vector: MID_BAND_VEC }]);
    expect((await relationRows(existing.id))[0]!.resolution).toBe('revision');

    // Round 2: revision 3 reintroduces October. It supersedes revision 2's
    // fact; the repair pass then finds it contradicts the September side.
    const regressGateway = new PairScriptedGateway((input) =>
      input.includes('agreed')
        ? { verdict: 'supersedes', direction: 'a_over_b', reason: 'changed again' }
        : { verdict: 'contradicts', direction: null, reason: 'October is back' },
    );
    const regressed = await seed(
      owner,
      'Atlas Migration go-live moved back to October 1.',
      MID_BAND_VEC,
      {
        kind: 'decision',
        subjectEntity: 'Atlas Migration',
      },
    );
    const svc = service(regressGateway);
    await runStage6(svc, [{ row: regressed, vector: MID_BAND_VEC }]);
    const second = await runStage6(svc, [{ row: regressed, vector: MID_BAND_VEC }], 'repair');
    expect(second.reopened).toBe(1);

    const relations = await relationRows(existing.id);
    expect(relations).toHaveLength(1);
    expect(relations[0]!.id).toBe(relation.id); // the SAME finding, not a new one
    expect(relations[0]!.resolved_at).toBeNull();
    expect(relations[0]!.resolution).toBeNull();
    const parties = [relations[0]!.a_memory_id, relations[0]!.b_memory_id];
    expect(parties).toContain(regressed.id);
    expect(parties).toContain(existing.id);
    expect(parties).not.toContain(incoming.id);
    const events = (await eventsFor(relation.id)).map((e) => e.event);
    expect(events).toEqual(['detected', 'resolved_by_revision', 'reopened']);
  });

  it('user resolution and revision resolution are uniformly represented', async () => {
    const owner = freshOwner('uniform');
    const { relation } = await seedOpenFinding(owner);
    await reconciliation.resolveContradiction(principalFor(owner), relation.id, {
      type: 'dismiss',
    });
    const [after] = await relationRows(relation.a_memory_id);
    expect(after!.resolved_at).not.toBeNull();
    expect(after!.resolution).toBe('dismissed');
    const events = (await eventsFor(relation.id)).map((e) => e.event);
    expect(events).toEqual(['detected', 'resolved_by_user']);
  });

  it('resolved findings never appear as current; a reopened one does again', async () => {
    const owner = freshOwner('current');
    const principal = principalFor(owner);
    const { relation } = await seedOpenFinding(owner);
    expect(await reconciliation.countOpenContradictions(principal)).toBe(1);

    await reconciliation.resolveContradiction(principal, relation.id, { type: 'dismiss' });
    expect(await reconciliation.countOpenContradictions(principal)).toBe(0);
    expect(await reconciliation.listOpenContradictions(principal)).toHaveLength(0);
    // Still queryable with history where history is asked for.
    const withResolved = await reconciliation.relationsForMemory(principal, relation.a_memory_id);
    expect(withResolved).toHaveLength(1);
    expect(withResolved[0]!.relation.resolution).toBe('dismissed');
  });

  it('an unchanged corpus re-run keeps every verdict and spends no model call (the ledger)', async () => {
    const owner = freshOwner('ledger');
    const gateway = new PairScriptedGateway(() => compatible);
    const svc = service(gateway);
    const first = await seed(owner, 'Pier 4 crane capacity is rated well.', BASE_VEC, {
      kind: 'fact',
      subjectEntity: 'Pier 4 crane',
    });
    const second = await seed(owner, 'Pier 4 crane needs an inspection soon.', MID_BAND_VEC, {
      kind: 'fact',
      subjectEntity: 'Pier 4 crane',
    });
    const run1 = await runStage6(svc, [{ row: second, vector: MID_BAND_VEC }]);
    expect(run1.contradictionChecks).toBe(1);
    expect(gateway.contradictionCalls).toBe(1);

    // The nightly re-examination of the SAME pair: verdict replayed from the
    // ledger, zero model calls, nothing flips.
    const run2 = await runStage6(svc, [{ row: second, vector: MID_BAND_VEC }], 'dreaming');
    expect(run2.ledgerHits).toBe(1);
    expect(run2.contradictionChecks).toBe(0);
    expect(gateway.contradictionCalls).toBe(1);
    expect(await relationRows(first.id)).toHaveLength(0);
  });

  it('a recorded alias pairs a cross-language conflict the bands never could', async () => {
    const owner = freshOwner('alias');
    await aliases.add(owner, 'Adriatic Foods', 'Jadranska hrana');
    const gateway = new PairScriptedGateway(() => ({
      verdict: 'contradicts',
      direction: null,
      reason: 'two capacities for one plant',
    }));
    const english = await seed(owner, 'Adriatic Foods plant capacity is 120 tonnes.', BASE_VEC, {
      kind: 'fact',
      subjectEntity: 'Adriatic Foods',
    });
    // Far vector: the embedding similarity is useless, as it is across
    // languages; only the alias-expanded subject search can find the pair.
    const croatian = await seed(owner, 'Kapacitet pogona Jadranske hrane je 90 tona.', FAR_VEC, {
      kind: 'fact',
      subjectEntity: 'Jadranska hrana',
    });
    const summary = await runStage6(service(gateway), [{ row: croatian, vector: FAR_VEC }]);
    expect(summary.contradictions).toBe(1);
    expect((await statusOf(english.id)).status).toBe('contradicted');
    expect((await statusOf(croatian.id)).status).toBe('contradicted');
  });
});
