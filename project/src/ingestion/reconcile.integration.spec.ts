import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { FactKind, Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryReconciliation } from '../memory/index';
import type { MemoryReconciliation, MemoryRow, MemoryStore, NewFact } from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { ReconciliationService } from './pipeline/reconcile.stage';
import { noopLog } from './pipeline/pipeline-log';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';

/**
 * Stage 6 end to end (decision 0010) against real Postgres + Qdrant, with the
 * judge scripted at the ModelGateway seam for determinism — live model
 * behavior is the reconciliation pair eval's job (§B.4).
 *
 * Vector control: the mid contradiction band needs an exact similarity, so
 * tests hand-build vectors — BASE = [1,0,…]; MID_BAND has raw cosine 0.7
 * against BASE, i.e. 0.85 normalized, inside [0.80, 0.93). Identical vectors
 * give 1.0 — the dedup/escalation path.
 */
const BASE_VEC = [1, 0, 0, 0, 0, 0, 0, 0];
const MID_BAND_VEC = [0.7, Math.sqrt(1 - 0.49), 0, 0, 0, 0, 0, 0];

type Judged = {
  verdict: string;
  reason: string;
  merged_content?: string | null;
  direction?: string | null;
};

class ScriptedJudgeGateway extends ModelGateway {
  dedupCalls = 0;
  contradictionCalls = 0;
  constructor(
    private dedup: () => Judged = () => ({
      verdict: 'distinct',
      reason: 'scripted',
      merged_content: null,
    }),
    private contradiction: () => Judged = () => ({
      verdict: 'compatible',
      direction: null,
      reason: 'scripted',
    }),
  ) {
    super();
  }
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used by reconciliation
  async *completeStream(): AsyncIterable<string> {
    throw new Error('not used');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return EMBED_MODEL;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    if (!request.input.startsWith('FACT A:')) throw new Error('unexpected non-reconcile call');
    const raw = request.system.includes('same_fact')
      ? (this.dedupCalls++, this.dedup())
      : (this.contradictionCalls++, this.contradiction());
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

const principalFor = (userId: string): Principal => ({
  userId,
  name: 'Rec Tester',
  email: null,
  orgId: 'org-rec',
  orgName: 'org-rec',
  roles: [],
});

describe('reconciliation stage 6 (integration, real Postgres + Qdrant, scripted judge)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let reconciliation: MemoryReconciliation;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    ({ store, reconciliation } = createMemoryReconciliation({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    }));
    await store.ensureIndexReady();
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  /** Seeds a committed memory with a controlled vector; unique source per row. */
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
      sourceId: randomUUID(),
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
    service: ReconciliationService,
    pairs: { row: MemoryRow; vector: number[] }[],
  ) =>
    tdb.db.transaction((tx) =>
      service.reconcile(
        tx,
        pairs.map(({ row, vector }) => ({ row, embedding: vector })),
        noopLog,
      ),
    );

  const service = (gateway: ScriptedJudgeGateway) =>
    new ReconciliationService(gateway, store, reconciliation);

  const memoryById = async (id: string) => {
    const { rows } = await tdb.pool.query<{
      status: string;
      superseded_by: string | null;
      valid_until: Date | null;
      content: string;
    }>(`SELECT status, superseded_by, valid_until, content FROM memory WHERE id = $1`, [id]);
    return rows[0];
  };
  const relationsFor = async (id: string) => {
    const { rows } = await tdb.pool.query<{
      id: string;
      a_memory_id: string;
      b_memory_id: string;
      a_prior_status: string;
      b_prior_status: string;
      resolved_at: Date | null;
      resolution: string | null;
    }>(`SELECT * FROM memory_relation WHERE a_memory_id = $1 OR b_memory_id = $1`, [id]);
    return rows;
  };
  const auditCount = async (action: string, entityId: string) => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND entity_id = $2`,
      [action, entityId],
    );
    return Number(rows[0]!.n);
  };

  it('stage6_idempotent: re-running reconciliation for a source changes nothing the second time', async () => {
    const owner = `rec-idem-${randomUUID()}`;
    const gateway = new ScriptedJudgeGateway(undefined, () => ({
      verdict: 'contradicts',
      direction: null,
      reason: 'two dates for one go-live',
    }));
    const svc = service(gateway);

    const existing = await seed(owner, 'Go-live is September 1.', BASE_VEC, {
      kind: 'decision',
      subjectEntity: 'Atlas Migration',
    });
    const incoming = await seed(owner, 'Go-live is October 1.', MID_BAND_VEC, {
      kind: 'decision',
      subjectEntity: 'Atlas Migration',
    });

    const first = await runStage6(svc, [{ row: incoming, vector: MID_BAND_VEC }]);
    expect(first.contradictions).toBe(1);
    expect((await memoryById(incoming.id))?.status).toBe('contradicted');
    expect((await memoryById(existing.id))?.status).toBe('contradicted');
    const relations = await relationsFor(incoming.id);
    expect(relations).toHaveLength(1);
    const callsAfterFirst = gateway.contradictionCalls;

    // Second delivery of the same source: the incoming fact is no longer
    // active/uncertain, so reconciliation skips it entirely — no model calls,
    // no new relations, no status churn.
    const incomingNow = { ...incoming, status: 'contradicted' as const };
    const second = await runStage6(svc, [{ row: incomingNow, vector: MID_BAND_VEC }]);
    expect(second.considered).toBe(0);
    expect(gateway.contradictionCalls).toBe(callsAfterFirst);
    expect(await relationsFor(incoming.id)).toHaveLength(1);
    expect((await memoryById(existing.id))?.status).toBe('contradicted');
  });

  // Every scenario gets its own owner: candidate generation is gated per
  // owner, so this is the isolation boundary between scenarios.
  const freshOwner = (name: string) => `rec-${name}-${randomUUID()}`;

  it('dedup_conservative: distinct/related merge nothing; same_fact merges per ruling 4 with history and survivor selection', async () => {
    // distinct and related verdicts: both rows stay exactly as they were.
    for (const verdict of ['distinct', 'related']) {
      const owner = freshOwner(`dedup-${verdict}`);
      const gateway = new ScriptedJudgeGateway(() => ({
        verdict,
        reason: 'scripted',
        merged_content: null,
      }));
      const existing = await seed(owner, `Fact ${verdict} existing`, BASE_VEC, {
        kind: 'commitment',
        entities: ['Ana', 'Marko'],
      });
      const incoming = await seed(owner, `Fact ${verdict} incoming`, BASE_VEC, {
        kind: 'commitment',
        entities: ['Ana', 'Marko'],
      });
      const summary = await runStage6(service(gateway), [{ row: incoming, vector: BASE_VEC }]);
      expect(summary.dedupChecks).toBeGreaterThan(0);
      expect(summary.merged).toBe(0);
      expect((await memoryById(existing.id))?.status).toBe('active');
      expect((await memoryById(incoming.id))?.status).toBe('active');
      expect((await memoryById(incoming.id))?.superseded_by).toBeNull();
    }

    // same_fact, no enrichment: newer incoming survives; older existing is
    // replaced pointing at it — history preserved, never deleted.
    {
      const owner = freshOwner('dedup-merge');
      const gateway = new ScriptedJudgeGateway(() => ({
        verdict: 'same_fact',
        reason: 'one fact twice',
        merged_content: null,
      }));
      const existing = await seed(owner, 'Ana will send the proposal to Marko.', BASE_VEC, {
        kind: 'commitment',
        entities: ['Ana', 'Marko'],
      });
      const incoming = await seed(owner, 'Ana will send the proposal to Marko.', BASE_VEC, {
        kind: 'commitment',
        entities: ['Ana', 'Marko'],
      });
      const summary = await runStage6(service(gateway), [{ row: incoming, vector: BASE_VEC }]);
      expect(summary.merged).toBe(1);
      const loser = await memoryById(existing.id);
      expect(loser?.status).toBe('replaced');
      expect(loser?.superseded_by).toBe(incoming.id);
      expect(loser?.valid_until).not.toBeNull();
      expect((await memoryById(incoming.id))?.status).toBe('active');
      expect(await auditCount('memory.merged', existing.id)).toBe(1);
    }

    // user_approved override: the OLDER user_approved memory survives the
    // newer active duplicate (user judgment outranks recency).
    {
      const owner = freshOwner('dedup-approved');
      const gateway = new ScriptedJudgeGateway(() => ({
        verdict: 'same_fact',
        reason: 'one fact twice',
        merged_content: null,
      }));
      const approved = await seed(owner, 'Luka approved the pilot budget.', BASE_VEC, {
        kind: 'decision',
        entities: ['Luka'],
        initialStatus: 'user_approved',
      });
      const incoming = await seed(owner, 'Luka approved the pilot budget.', BASE_VEC, {
        kind: 'decision',
        entities: ['Luka'],
      });
      await runStage6(service(gateway), [{ row: incoming, vector: BASE_VEC }]);
      expect((await memoryById(approved.id))?.status).toBe('user_approved'); // untouched
      const loser = await memoryById(incoming.id);
      expect(loser?.status).toBe('replaced');
      expect(loser?.superseded_by).toBe(approved.id);
    }

    // Enrichment: merged_content supersedes the survivor; both parties point
    // at the enriched successor; entity union carried over.
    {
      const owner = freshOwner('dedup-enrich');
      const enriched = 'Luka approved the pilot budget of 40,000 EUR.';
      const gateway = new ScriptedJudgeGateway(() => ({
        verdict: 'same_fact',
        reason: 'same decision, one carries the amount',
        merged_content: enriched,
      }));
      const existing = await seed(owner, 'Budget approved at 40,000 EUR by Luka.', BASE_VEC, {
        kind: 'decision',
        entities: ['Luka', 'Adriatic Foods'],
      });
      const incoming = await seed(owner, 'Budget approved at 40,000 EUR by Luka.', BASE_VEC, {
        kind: 'decision',
        entities: ['Luka'],
      });
      const summary = await runStage6(service(gateway), [{ row: incoming, vector: BASE_VEC }]);
      expect(summary.merged).toBe(1);
      expect(summary.enriched).toBe(1);
      const survivor = await memoryById(incoming.id);
      expect(survivor?.status).toBe('replaced'); // superseded by the enriched successor
      const successorId = survivor!.superseded_by!;
      const successor = await memoryById(successorId);
      expect(successor?.status).toBe('active');
      expect(successor?.content).toBe(enriched);
      expect((await memoryById(existing.id))?.superseded_by).toBe(successorId);
      const { rows } = await tdb.pool.query<{ entities: string[] }>(
        `SELECT entities FROM memory WHERE id = $1`,
        [successorId],
      );
      expect(new Set(rows[0]!.entities)).toEqual(new Set(['Luka', 'Adriatic Foods']));
    }
  });

  it('contradiction_marks_both: both memories contradicted, relation created once, prior statuses recorded', async () => {
    const owner = `rec-both-${randomUUID()}`;
    const gateway = new ScriptedJudgeGateway(undefined, () => ({
      verdict: 'contradicts',
      direction: null,
      reason: 'incompatible values',
    }));
    const svc = service(gateway);

    const approved = await seed(owner, 'The workshops run on Teams.', BASE_VEC, {
      kind: 'decision',
      subjectEntity: 'Ana',
      initialStatus: 'user_approved',
    });
    const incoming = await seed(owner, 'The workshops run on Zoom.', MID_BAND_VEC, {
      kind: 'decision',
      subjectEntity: 'Ana',
    });

    await runStage6(svc, [{ row: incoming, vector: MID_BAND_VEC }]);
    expect((await memoryById(incoming.id))?.status).toBe('contradicted');
    expect((await memoryById(approved.id))?.status).toBe('contradicted'); // the one legal touch
    const relations = await relationsFor(incoming.id);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      a_memory_id: incoming.id,
      b_memory_id: approved.id,
      a_prior_status: 'active',
      b_prior_status: 'user_approved',
      resolved_at: null,
      resolution: null,
    });
    expect(await auditCount('memory.contradiction_detected', relations[0]!.id)).toBe(1);

    // QS-1 (decision 0025): the model's explanation lives on the owner-gated
    // relation row; the org-readable audit detail carries ids only — no
    // free-text 'reason' key, ever.
    const { rows: reasonRows } = await tdb.pool.query<{ reason: string | null }>(
      `SELECT reason FROM memory_relation WHERE id = $1`,
      [relations[0]!.id],
    );
    expect(reasonRows[0]?.reason).toBe('incompatible values');
    const { rows: auditRows } = await tdb.pool.query<{ detail_json: Record<string, unknown> }>(
      `SELECT detail_json FROM audit_log
       WHERE action = 'memory.contradiction_detected' AND entity_id = $1`,
      [relations[0]!.id],
    );
    expect(auditRows[0]?.detail_json).not.toHaveProperty('reason');
    expect(auditRows[0]?.detail_json).toMatchObject({ a: incoming.id, b: approved.id });

    // Idempotent under a second detection attempt: the canonical-pair unique
    // index tombstones the relation.
    const again = await tdb.db.transaction((tx) =>
      reconciliation.createContradiction(tx, incoming.id, approved.id, 'again'),
    );
    expect(again.action).toBe('skipped');
    expect(await relationsFor(incoming.id)).toHaveLength(1);
  });

  it('resolution_flows: confirm / correct / dismiss produce the ruled outcomes, resolve the relation, audit', async () => {
    const gateway = new ScriptedJudgeGateway(undefined, () => ({
      verdict: 'contradicts',
      direction: null,
      reason: 'scripted',
    }));
    const svc = service(gateway);

    const detect = async (
      name: string,
      aContent: string,
      bContent: string,
      bOpts: Partial<NewFact> = {},
    ) => {
      const owner = freshOwner(`res-${name}`);
      const principal = principalFor(owner);
      const b = await seed(owner, bContent, BASE_VEC, {
        kind: 'fact',
        subjectEntity: 'Jadran',
        ...bOpts,
      });
      const a = await seed(owner, aContent, MID_BAND_VEC, {
        kind: 'fact',
        subjectEntity: 'Jadran',
        validFrom: new Date('2026-06-01T00:00:00Z'),
      });
      await runStage6(svc, [{ row: a, vector: MID_BAND_VEC }]);
      const [relation] = await relationsFor(a.id);
      expect(relation).toBeDefined();
      return { a, b, relation: relation!, principal };
    };

    // confirm A — directly corrected loser: replaced, pointing at the winner.
    {
      const { a, b, relation, principal } = await detect(
        'confirm',
        'Budget is 60k.',
        'Budget is 45k.',
      );
      await reconciliation.resolveContradiction(principal, relation.id, {
        type: 'confirm',
        winner: 'a',
      });
      expect((await memoryById(a.id))?.status).toBe('user_approved');
      const loser = await memoryById(b.id);
      expect(loser?.status).toBe('replaced');
      expect(loser?.superseded_by).toBe(a.id);
      const [resolved] = await relationsFor(a.id);
      expect(resolved?.resolution).toBe('confirmed_a');
      expect(resolved?.resolved_at).not.toBeNull();
      expect(await auditCount('memory.contradiction_resolved', relation.id)).toBe(1);
    }

    // confirm A — time-superseded loser (its own interval closed before the
    // confirmed fact began): outdated, no pointer.
    {
      const { a, b, relation, principal } = await detect(
        'timesup',
        'Office is in Rijeka.',
        'Office is in Osijek.',
        {
          validFrom: new Date('2026-01-01T00:00:00Z'),
          validUntil: new Date('2026-02-01T00:00:00Z'),
        },
      );
      await reconciliation.resolveContradiction(principal, relation.id, {
        type: 'confirm',
        winner: 'a',
      });
      expect((await memoryById(a.id))?.status).toBe('user_approved');
      const loser = await memoryById(b.id);
      expect(loser?.status).toBe('outdated');
      expect(loser?.superseded_by).toBeNull();
    }

    // correct both — edit-as-supersession per memory, relation `corrected`.
    {
      const { a, b, relation, principal } = await detect(
        'correct',
        'Sync is Tuesday.',
        'Sync is Wednesday.',
      );
      await reconciliation.resolveContradiction(principal, relation.id, {
        type: 'correct',
        aContent: 'Sync is Thursday at 9:00.',
        bContent: 'Sync was Wednesday until June.',
      });
      for (const id of [a.id, b.id]) {
        const row = await memoryById(id);
        expect(row?.status).toBe('replaced');
        const successor = await memoryById(row!.superseded_by!);
        expect(successor?.status).toBe('user_approved');
      }
      const [resolved] = await relationsFor(a.id);
      expect(resolved?.resolution).toBe('corrected');
    }

    // dismiss — both restored to their recorded prior statuses; re-running
    // detection afterwards is blocked by the tombstone.
    {
      const { a, b, relation, principal } = await detect(
        'dismiss',
        'Pilot ends in Q3.',
        'Pilot ends in Q4.',
      );
      await reconciliation.resolveContradiction(principal, relation.id, { type: 'dismiss' });
      expect((await memoryById(a.id))?.status).toBe('active');
      expect((await memoryById(b.id))?.status).toBe('active');
      const [resolved] = await relationsFor(a.id);
      expect(resolved?.resolution).toBe('dismissed');
      expect(await auditCount('memory.contradiction_dismiss_restored', a.id)).toBe(1);

      const rerun = await runStage6(svc, [
        { row: { ...a, status: 'active' as const }, vector: MID_BAND_VEC },
      ]);
      expect(rerun.contradictions).toBe(0); // tombstone: dismissed stays dismissed
      expect((await memoryById(a.id))?.status).toBe('active');
      expect(await relationsFor(a.id)).toHaveLength(1);

      // Resolving an already-resolved relation is an idempotent no-op.
      const again = await reconciliation.resolveContradiction(principal, relation.id, {
        type: 'dismiss',
      });
      expect(again.alreadyResolved).toBe(true);
    }
  });

  it('user_approved_shielded: reconciliation never transitions user_approved except into a contradiction pairing', async () => {
    // Both user_approved + same_fact: no action at all.
    {
      const owner = freshOwner('shield-both');
      const gateway = new ScriptedJudgeGateway(() => ({
        verdict: 'same_fact',
        reason: 'scripted',
        merged_content: null,
      }));
      const older = await seed(owner, 'Confirmed fact, twice approved.', BASE_VEC, {
        kind: 'fact',
        initialStatus: 'user_approved',
        entities: ['Ana'],
      });
      const newer = await seed(owner, 'Confirmed fact, twice approved.', BASE_VEC, {
        kind: 'fact',
        initialStatus: 'user_approved',
        entities: ['Ana'],
      });
      // user_approved incoming is skipped up front (not active/uncertain) —
      // and even a direct merge attempt refuses the pair.
      const summary = await runStage6(service(gateway), [{ row: newer, vector: BASE_VEC }]);
      expect(summary.considered).toBe(0);
      const direct = await tdb.db.transaction((tx) =>
        reconciliation.mergeSameFact(tx, newer.id, older.id, null, 'scripted'),
      );
      expect(direct.action).toBe('skipped');
      expect((await memoryById(older.id))?.status).toBe('user_approved');
      expect((await memoryById(newer.id))?.status).toBe('user_approved');
    }

    // Enrichment never supersedes a user_approved survivor, even when the
    // model composed merged content.
    {
      const owner = freshOwner('shield-enrich');
      const gateway = new ScriptedJudgeGateway(() => ({
        verdict: 'same_fact',
        reason: 'scripted',
        merged_content: 'Enriched content that must not be applied.',
      }));
      const approved = await seed(owner, 'Approved fact with detail.', BASE_VEC, {
        kind: 'fact',
        entities: ['Marko'],
        initialStatus: 'user_approved',
      });
      const incoming = await seed(owner, 'Approved fact with detail.', BASE_VEC, {
        kind: 'fact',
        entities: ['Marko'],
      });
      const before = await tdb.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM memory WHERE owner_id = $1`,
        [owner],
      );
      const summary = await runStage6(service(gateway), [{ row: incoming, vector: BASE_VEC }]);
      expect(summary.merged).toBe(1);
      expect(summary.enriched).toBe(0);
      const after = await tdb.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM memory WHERE owner_id = $1`,
        [owner],
      );
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n); // no successor row created
      expect((await memoryById(approved.id))?.status).toBe('user_approved');
      expect((await memoryById(incoming.id))?.superseded_by).toBe(approved.id);
    }

    // supersedes verdict against a user_approved party routes to
    // contradiction — the user decides, never a silent supersession.
    {
      const owner = freshOwner('shield-supersede');
      const gateway = new ScriptedJudgeGateway(undefined, () => ({
        verdict: 'supersedes',
        direction: 'a_over_b',
        reason: 'scripted update',
      }));
      const approved = await seed(owner, 'Invoices go to the old address.', BASE_VEC, {
        kind: 'fact',
        subjectEntity: 'Adriatic Foods',
        initialStatus: 'user_approved',
        validFrom: new Date('2026-05-01T00:00:00Z'),
      });
      const incoming = await seed(owner, 'Invoices go to the new address.', MID_BAND_VEC, {
        kind: 'fact',
        subjectEntity: 'Adriatic Foods',
        validFrom: new Date('2026-06-01T00:00:00Z'),
      });
      const summary = await runStage6(service(gateway), [{ row: incoming, vector: MID_BAND_VEC }]);
      expect(summary.superseded).toBe(0);
      expect(summary.contradictions).toBe(1);
      expect((await memoryById(approved.id))?.status).toBe('contradicted');
      expect((await memoryById(incoming.id))?.status).toBe('contradicted');
    }
  });

  it('supersedes_direction_guard: ambiguous direction routes to contradiction, never silent supersession', async () => {
    // Unambiguous: the model's winner is also temporally later → §B.2 close.
    {
      const owner = freshOwner('guard-clean');
      const gateway = new ScriptedJudgeGateway(undefined, () => ({
        verdict: 'supersedes',
        direction: 'a_over_b',
        reason: 'explicit update',
      }));
      const older = await seed(owner, 'Sync is on Tuesdays.', BASE_VEC, {
        kind: 'fact',
        subjectEntity: 'Weekly Sync',
        validFrom: new Date('2026-05-01T00:00:00Z'),
      });
      const incoming = await seed(owner, 'Sync moved to Thursdays.', MID_BAND_VEC, {
        kind: 'fact',
        subjectEntity: 'Weekly Sync',
        validFrom: new Date('2026-06-01T00:00:00Z'),
      });
      const summary = await runStage6(service(gateway), [{ row: incoming, vector: MID_BAND_VEC }]);
      expect(summary.superseded).toBe(1);
      expect(summary.contradictions).toBe(0);
      const loser = await memoryById(older.id);
      expect(loser?.status).toBe('replaced');
      expect(loser?.superseded_by).toBe(incoming.id);
      expect(await relationsFor(incoming.id)).toHaveLength(0);
    }

    // Ambiguous: the model's winner is temporally EARLIER → contradiction.
    {
      const owner = freshOwner('guard-ambiguous');
      const gateway = new ScriptedJudgeGateway(undefined, () => ({
        verdict: 'supersedes',
        direction: 'a_over_b',
        reason: 'claimed update, wrong order',
      }));
      const existing = await seed(owner, 'Report due end of June.', BASE_VEC, {
        kind: 'fact',
        subjectEntity: 'Quarterly Report',
        validFrom: new Date('2026-06-30T00:00:00Z'),
      });
      const incoming = await seed(owner, 'Report due mid June.', MID_BAND_VEC, {
        kind: 'fact',
        subjectEntity: 'Quarterly Report',
        validFrom: new Date('2026-06-15T00:00:00Z'),
      });
      const summary = await runStage6(service(gateway), [{ row: incoming, vector: MID_BAND_VEC }]);
      expect(summary.superseded).toBe(0);
      expect(summary.contradictions).toBe(1);
      expect((await memoryById(existing.id))?.status).toBe('contradicted');
      expect((await memoryById(incoming.id))?.status).toBe('contradicted');
    }

    // Direction missing entirely → contradiction, same guard.
    {
      const owner = freshOwner('guard-nodirection');
      const gateway = new ScriptedJudgeGateway(undefined, () => ({
        verdict: 'supersedes',
        direction: null,
        reason: 'update claimed without direction',
      }));
      const existing = await seed(owner, 'Kickoff is in Zagreb.', BASE_VEC, {
        kind: 'decision',
        subjectEntity: 'Kickoff',
      });
      const incoming = await seed(owner, 'Kickoff is in Split.', MID_BAND_VEC, {
        kind: 'decision',
        subjectEntity: 'Kickoff',
      });
      const summary = await runStage6(service(gateway), [{ row: incoming, vector: MID_BAND_VEC }]);
      expect(summary.superseded).toBe(0);
      expect(summary.contradictions).toBe(1);
      expect((await memoryById(existing.id))?.status).toBe('contradicted');
    }
  });
});
