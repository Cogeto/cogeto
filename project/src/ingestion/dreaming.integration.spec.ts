import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { FactKind, Principal } from '@cogeto/shared';
import { startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryReconciliation } from '../memory/index';
import type { MemoryReconciliation, MemoryRow, MemoryStore, NewFact } from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import type { AuthenticatedRequest } from '../identity/index';
import { DreamingService } from './dreaming.service';
import { DreamingController } from './dreaming.controller';
import { ReconciliationService } from './pipeline/reconcile.stage';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';

/** Controlled vectors (see reconcile.integration.spec): 0.85 normalized. */
const BASE_VEC = [1, 0, 0, 0, 0, 0, 0, 0];
const MID_BAND_VEC = [0.7, Math.sqrt(1 - 0.49), 0, 0, 0, 0, 0, 0];
const FAR_VEC = [0, 0, 1, 0, 0, 0, 0, 0];

class CountingJudgeGateway extends ModelGateway {
  calls = 0;
  constructor(
    private readonly contradiction: () => Record<string, unknown> = () => ({
      verdict: 'contradicts',
      direction: null,
      reason: 'scripted',
    }),
  ) {
    super();
  }
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used by dreaming
  async *completeStream(): AsyncIterable<string> {
    throw new Error('not used');
  }
  async embed(): Promise<number[][]> {
    throw new Error('dreaming must never re-embed');
  }
  embeddingModelId(): string {
    return EMBED_MODEL;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    this.calls += 1;
    const raw = request.system.includes('same_fact')
      ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
      : this.contradiction();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

const principalFor = (userId: string): Principal => ({
  userId,
  name: 'Dream Tester',
  email: null,
  orgId: 'org-dream',
  orgName: 'org-dream',
  roles: [],
});

describe('dreaming cycle (integration, real Postgres + Qdrant, scripted judge)', () => {
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

  const dreamer = (gateway: CountingJudgeGateway) =>
    new DreamingService(tdb.db, store, new ReconciliationService(gateway, store, reconciliation));

  const seed = async (
    owner: string,
    content: string,
    vector: number[] | null,
    opts: Partial<NewFact> & { kind?: FactKind; backdateDays?: number } = {},
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
    if (vector) await store.upsertVectors([row], [vector]);
    if (opts.backdateDays) {
      const then = new Date(Date.now() - opts.backdateDays * 24 * 3600 * 1000);
      await tdb.pool.query(`UPDATE memory SET created_at = $2, updated_at = $2 WHERE id = $1`, [
        row.id,
        then,
      ]);
    }
    return row;
  };

  const statusOf = async (id: string): Promise<string | null> => {
    const { rows } = await tdb.pool.query<{ status: string }>(
      `SELECT status FROM memory WHERE id = $1`,
      [id],
    );
    return rows[0]?.status ?? null;
  };
  const actionsForRun = async (runId: string) => {
    const { rows } = await tdb.pool.query<{ pass: string; memory_id: string }>(
      `SELECT pass, memory_id FROM dream_action WHERE run_id = $1`,
      [runId],
    );
    return rows;
  };

  const hourAgo = () => new Date(Date.now() - 3600 * 1000);

  it("dreaming_incremental: only the day's facts and touched memories are processed", async () => {
    const owner = `dream-inc-${randomUUID()}`;
    const gateway = new CountingJudgeGateway();
    // Old facts, outside the window — must not even be considered.
    const oldFact = await seed(owner, 'Old news from last week.', FAR_VEC, {
      kind: 'fact',
      subjectEntity: 'Stari projekt',
      backdateDays: 3,
    });
    // The batch target: an existing (old) memory the NEW fact conflicts with.
    const existing = await seed(owner, 'Go-live is September 1.', BASE_VEC, {
      kind: 'decision',
      subjectEntity: 'Atlas Migration',
      backdateDays: 2,
    });
    const fresh = await seed(owner, 'Go-live is October 1.', MID_BAND_VEC, {
      kind: 'decision',
      subjectEntity: 'Atlas Migration',
    });

    const report = await dreamer(gateway).run(undefined, { scopeFrom: hourAgo() });
    expect(report.considered).toBe(1); // the fresh fact only — never the store
    expect(report.contradictions).toBe(1);
    expect(await statusOf(fresh.id)).toBe('contradicted');
    expect(await statusOf(existing.id)).toBe('contradicted'); // touched via the pair
    expect(await statusOf(oldFact.id)).toBe('active'); // out of scope, untouched
    const actions = await actionsForRun(report.runId);
    expect(actions).toEqual([{ pass: 'contradiction', memory_id: fresh.id }]);
  });

  it('dreaming_idempotent: re-running the same window changes nothing', async () => {
    const owner = `dream-idem-${randomUUID()}`;
    const gateway = new CountingJudgeGateway();
    const scopeFrom = hourAgo();
    await seed(owner, 'Budget is 60k.', BASE_VEC, { kind: 'fact', subjectEntity: 'Jadran' });
    await seed(owner, 'Budget is 45k.', MID_BAND_VEC, { kind: 'fact', subjectEntity: 'Jadran' });

    const first = await dreamer(gateway).run(undefined, { scopeFrom });
    expect(first.contradictions).toBe(1);
    const callsAfterFirst = gateway.calls;
    const relationCount = async () => {
      const { rows } = await tdb.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM memory_relation`,
      );
      return Number(rows[0]!.n);
    };
    const relationsBefore = await relationCount();

    const second = await dreamer(gateway).run(undefined, { scopeFrom });
    expect(second.contradictions).toBe(0);
    expect(second.merged).toBe(0);
    expect(second.superseded).toBe(0);
    expect(second.outdated).toBe(0);
    expect(second.dormantFlagged).toBe(0);
    expect(await relationCount()).toBe(relationsBefore);
    expect(await actionsForRun(second.runId)).toHaveLength(0);
    // Both facts are contradicted now, so the engine skipped them entirely.
    expect(gateway.calls).toBe(callsAfterFirst);
  });

  it('staleness_deterministic: lapsed valid_until → outdated with zero model calls', async () => {
    const owner = `dream-stale-${randomUUID()}`;
    const gateway = new CountingJudgeGateway();
    const lapsed = await seed(owner, 'Contractor access until yesterday.', FAR_VEC, {
      kind: 'fact',
      validFrom: new Date(Date.now() - 10 * 24 * 3600 * 1000),
      validUntil: new Date(Date.now() - 24 * 3600 * 1000),
    });

    const report = await dreamer(gateway).run(undefined, { scopeFrom: hourAgo() });
    expect(report.outdated).toBeGreaterThanOrEqual(1);
    expect(await statusOf(lapsed.id)).toBe('outdated');
    expect(gateway.calls).toBe(0); // deterministic pass — no model involved
    const actions = await actionsForRun(report.runId);
    expect(actions).toContainEqual({ pass: 'staleness', memory_id: lapsed.id });
    // The transition is the consolidation actor's, audited like any other.
    const { rows } = await tdb.pool.query<{ actor: string }>(
      `SELECT actor FROM audit_log WHERE action = 'memory.status_transition' AND entity_id = $1`,
      [lapsed.id],
    );
    expect(rows.map((r) => r.actor)).toContain('consolidation');
  });

  it('dormant_flags_written: a quiet commitment is flagged, not transitioned', async () => {
    const owner = `dream-quiet-${randomUUID()}`;
    const gateway = new CountingJudgeGateway();
    const quiet = await seed(owner, 'Will send Dario the onboarding checklist.', FAR_VEC, {
      kind: 'commitment',
      entities: ['Dario'],
      subjectEntity: 'Dario',
      backdateDays: 20,
    });

    const svc = dreamer(gateway);
    const report = await svc.run(undefined, { scopeFrom: hourAgo() });
    expect(report.dormantFlagged).toBeGreaterThanOrEqual(1);
    expect(await statusOf(quiet.id)).toBe('active'); // flagged, NEVER transitioned
    const flags = await tdb.pool.query<{ cleared_at: Date | null }>(
      `SELECT cleared_at FROM dormant_flag WHERE memory_id = $1`,
      [quiet.id],
    );
    expect(flags.rows).toHaveLength(1);
    expect(flags.rows[0]!.cleared_at).toBeNull();

    // Re-run: the open-flag unique index makes flagging idempotent.
    const second = await svc.run(undefined, { scopeFrom: hourAgo() });
    expect(second.dormantFlagged).toBe(0);
    expect(
      (await tdb.pool.query(`SELECT 1 FROM dormant_flag WHERE memory_id = $1`, [quiet.id])).rows,
    ).toHaveLength(1);

    // The user settles the commitment; the next cycle clears the flag.
    await store.transition({ kind: 'user', userId: owner }, quiet.id, 'outdated', 'done');
    const third = await svc.run(undefined, { scopeFrom: hourAgo() });
    expect(third.flagsCleared).toBeGreaterThanOrEqual(1);
    const cleared = await tdb.pool.query<{ cleared_at: Date | null }>(
      `SELECT cleared_at FROM dormant_flag WHERE memory_id = $1`,
      [quiet.id],
    );
    expect(cleared.rows[0]!.cleared_at).not.toBeNull();
  });

  it('digest_links_resolve: every rendered line targets something that exists for the caller', async () => {
    const owner = `dream-digest-${randomUUID()}`;
    const principal = principalFor(owner);
    const gateway = new CountingJudgeGateway();

    await seed(owner, 'Workshop platform is Teams.', BASE_VEC, {
      kind: 'decision',
      subjectEntity: 'Ana',
      backdateDays: 2,
    });
    const freshConflict = await seed(owner, 'Workshop platform is Zoom.', MID_BAND_VEC, {
      kind: 'decision',
      subjectEntity: 'Ana',
    });
    const lapsed = await seed(owner, 'Offer valid until yesterday.', FAR_VEC, {
      kind: 'fact',
      validUntil: new Date(Date.now() - 24 * 3600 * 1000),
    });
    const quiet = await seed(owner, 'Will prepare the summit recap.', FAR_VEC, {
      kind: 'commitment',
      subjectEntity: 'Summit',
      backdateDays: 20,
    });

    const report = await dreamer(gateway).run(undefined, { scopeFrom: hourAgo() });
    expect(report.contradictions).toBe(1);

    const controller = new DreamingController(tdb.db, store);
    const digest = await controller.latest({ principal } as AuthenticatedRequest);
    expect(digest.runId).toBe(report.runId);
    expect(digest.lines.length).toBeGreaterThanOrEqual(3);
    expect(digest.lines.length).toBeLessThanOrEqual(6);

    const staticTargets = new Set([
      '/review?tab=contradicted',
      '/memories?status=outdated',
      '/memories',
    ]);
    for (const line of digest.lines) {
      if (staticTargets.has(line.href)) continue;
      const match = /^\/memories\?open=(.+)$/.exec(line.href);
      expect(match, `unexpected link target: ${line.href}`).not.toBeNull();
      const row = await store.getForPrincipal(principal, match![1]!, { includeSensitive: true });
      expect(row, `digest links to an invisible memory: ${line.href}`).not.toBeNull();
    }
    // The three passes each produced their line shape.
    expect(digest.lines.some((l) => l.href === '/review?tab=contradicted')).toBe(true);
    expect(digest.lines.some((l) => l.href === '/memories?status=outdated')).toBe(true);
    expect(digest.lines.some((l) => l.href === `/memories?open=${quiet.id}`)).toBe(true);
    // And another user sees NONE of it — gated resolution, not filtering.
    const stranger = await controller.latest({
      principal: principalFor(`stranger-${randomUUID()}`),
    } as AuthenticatedRequest);
    expect(stranger.lines).toEqual([]);
    void freshConflict;
    void lapsed;
  });

  it('empty_run_silent: a run with nothing in scope produces no lines for anyone', async () => {
    const gateway = new CountingJudgeGateway();
    // Fresh, empty window: nothing admitted or touched in the last second.
    const report = await dreamer(gateway).run(undefined, {
      scopeFrom: new Date(Date.now() - 1000),
    });
    expect(report.considered).toBe(0);
    expect(report.outdated).toBe(0);
    expect(report.dormantFlagged).toBe(0);
    expect(await actionsForRun(report.runId)).toHaveLength(0);

    const controller = new DreamingController(tdb.db, store);
    const digest = await controller.latest({
      principal: principalFor(`anyone-${randomUUID()}`),
    } as AuthenticatedRequest);
    expect(digest.runId).toBe(report.runId); // the empty run IS the latest
    expect(digest.lines).toEqual([]); // → the panel renders nothing
  });
});
