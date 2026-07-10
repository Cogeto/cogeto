import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import {
  fakeEmbedding,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../../testing/index';
import { createMemoryStore, MemoryObjectStore, reindexMemories } from '../../memory/index';
import type { MemoryStore } from '../../memory/index';
import { ModelGateway } from '../../model-gateway/index';
import { assertEndState, inspectEndState } from './assertions';
import { fileObjectKeys, truncateDomainTables } from './ops';

/**
 * demo_seed_asserts + demo_reset_idempotent (decision 0022, §B.9) against real
 * Postgres + Qdrant + MinIO. These cover the demo-specific, deterministic code —
 * the end-state assertion harness and the reset wipe — using a world shaped
 * exactly as the pipeline produces it. (The full HTTP-seed → extract → dream path
 * is a real LLM: it is exercised for real by `docker compose --profile demo up`
 * and guarded from bypass by `demo_pipeline_real`.)
 */

const DIMS = 8;
const EMBED = 'test-embed';

/** Minimal gateway: only embed() is used (by reindex). */
class FakeGateway extends ModelGateway {
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unused');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return EMBED;
  }
  async extractStructured<T>(_schema: ZodType<T>): Promise<T> {
    throw new Error('unused');
  }
}

const principal: Principal = {
  userId: 'demo-ana',
  name: 'Ana Kovač',
  email: null,
  orgId: 'demo-org',
  orgName: 'Cogeto Sandbox',
  roles: [],
};

describe('Ana sandbox seed/reset (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let store: MemoryStore;
  let objects: MemoryObjectStore;
  const gateway = new FakeGateway();

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED, dimensions: DIMS },
    });
    await store.ensureIndexReady();
    objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    await buildWorld();
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb?.stop(), qdrant?.stop(), minio?.stop()]);
  });

  /** A memory created the real way (so it carries content + provenance). */
  async function fact(
    content: string,
    opts: {
      kind?: 'commitment' | 'decision' | 'preference' | 'fact' | 'open_loop';
      status?: 'active' | 'uncertain';
      sourceType?: 'user_note' | 'chat' | 'file';
      sourceId?: string;
      entities?: string[];
    } = {},
  ): Promise<string> {
    const row = await store.createFromFact(principal, {
      content,
      scope: 'private',
      kind: opts.kind ?? 'fact',
      sourceType: opts.sourceType ?? 'user_note',
      sourceId: opts.sourceId ?? randomUUID(),
      entities: opts.entities ?? [],
      initialStatus: opts.status ?? 'active',
      embeddingModel: EMBED,
    });
    return row.id;
  }

  const setStatus = (id: string, status: string): Promise<unknown> =>
    tdb.pool.query('UPDATE memory SET status = $2 WHERE id = $1', [id, status]);

  /** Builds a world shaped exactly as the pipeline + dreaming produce it. */
  async function buildWorld(): Promise<string> {
    // 8 active facts, one a Marko commitment (the demo answer).
    const markoId = await fact(
      'Promised Marko the revised Atlas proposal once he confirms the Q3 budget.',
      { kind: 'commitment', entities: ['Marko'] },
    );
    const activeIds = [markoId];
    for (let i = 0; i < 7; i += 1) {
      activeIds.push(
        await fact(`Active fact number ${i}: Atlas migration detail ${i}.`, {
          kind: i % 2 ? 'decision' : 'fact',
        }),
      );
    }

    // Contradiction pair (relation + both contradicted).
    const goliveA = await fact('Atlas CRM Migration go-live is September 1.', { kind: 'decision' });
    const goliveB = await fact('Atlas CRM Migration go-live is October 1.', { kind: 'decision' });
    await setStatus(goliveA, 'contradicted');
    await setStatus(goliveB, 'contradicted');
    await tdb.pool.query(
      `INSERT INTO memory_relation (kind, a_memory_id, b_memory_id, a_prior_status, b_prior_status)
       VALUES ('contradicts', $1, $2, 'active', 'active')`,
      [goliveB, goliveA],
    );

    // Lapsed (outdated), hedged (uncertain), superseded (replaced).
    await setStatus(await fact('Contractor staging access expired 30 June 2026.'), 'outdated');
    await fact('Marko may prefer Teams over Zoom for the workshops.', { status: 'uncertain' });
    await setStatus(await fact('Invoices go to racuni@adriaticfoods.hr.'), 'replaced');

    // The uploaded document: MinIO object + file_metadata + a file-source memory.
    const objectKey = `${principal.orgId}/${principal.userId}/private/file-${randomUUID()}`;
    await objects.putObject(objectKey, Buffer.from('Consulting agreement: EUR 12,000/month.'));
    await tdb.pool.query(
      `INSERT INTO file_metadata (object_key, owner_id, scope, sensitive) VALUES ($1, $2, 'private', false)`,
      [objectKey, principal.userId],
    );
    await fact('Consulting agreement fee is EUR 12,000 per month.', {
      sourceType: 'file',
      sourceId: objectKey,
    });

    // Three derived tasks: blocked-on-condition, dormant, open.
    await insertTask(activeIds[0]!, 'blocked_on_condition', {
      condition: 'after Marko confirms the Q3 budget',
    });
    await insertTask(activeIds[1]!, 'open', { dormant: true });
    await insertTask(activeIds[2]!, 'open', {});

    // Embed the world so Qdrant carries points (what reset must clear).
    await reindexMemories({
      db: tdb.db,
      gateway,
      qdrantUrl: qdrant.url,
      embeddingModel: EMBED,
      dimensions: DIMS,
    });
    return objectKey;
  }

  const insertTask = (
    memoryId: string,
    status: string,
    opts: { condition?: string; dormant?: boolean },
  ): Promise<unknown> =>
    tdb.pool.query(
      `INSERT INTO task (owner_id, scope, derived_from_memory_id, title, status, condition_text, dormant)
       VALUES ($1, 'private', $2, $3, $4, $5, $6)`,
      [
        principal.userId,
        memoryId,
        'derived task',
        status,
        opts.condition ?? null,
        opts.dormant ?? false,
      ],
    );

  const qdrantPointCount = async (): Promise<number> => {
    const res = await fetch(`${qdrant.url}/collections/memories/points/count`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exact: true }),
    });
    const body = (await res.json()) as { result?: { count?: number } };
    return body.result?.count ?? 0;
  };

  it('demo_seed_asserts: the seeded world satisfies every hard assertion', async () => {
    const state = await inspectEndState(tdb.pool, principal.userId);
    expect(state.hardFailures, state.hardFailures.join('; ')).toHaveLength(0);
    expect(() => assertEndState(state)).not.toThrow();

    // The assertions have teeth: a world missing its contradiction pair fails.
    const broken = { ...state, contradictionRelations: 0, hardFailures: ['no contradiction'] };
    expect(() => assertEndState(broken)).toThrow(/FAILED/);

    // Sanity on the specific structural facts the pitch depends on.
    expect(state.contradictionRelations).toBeGreaterThanOrEqual(1);
    expect(state.statusCounts['contradicted']).toBeGreaterThanOrEqual(2);
    expect(state.statusCounts['outdated']).toBeGreaterThanOrEqual(1);
    expect(state.statusCounts['uncertain']).toBeGreaterThanOrEqual(1);
    expect(state.blockedTasks).toBeGreaterThanOrEqual(1);
    expect(state.documentMemories).toBeGreaterThanOrEqual(1);
    expect(state.markoCommitments).toBeGreaterThanOrEqual(1);
  });

  it('demo_reset_idempotent: reset wipes everything, and a re-seed yields the same asserted state', async () => {
    const before = await inspectEndState(tdb.pool, principal.userId);
    expect(await qdrantPointCount()).toBeGreaterThan(0);
    const keys = await fileObjectKeys(tdb.pool);
    expect(keys.length).toBeGreaterThan(0);

    // ── The reset wipe ─────────────────────────────────────────────────────
    for (const key of keys) await objects.deleteObject(key);
    const truncated = await truncateDomainTables(tdb.pool);
    await reindexMemories({
      db: tdb.db,
      gateway,
      qdrantUrl: qdrant.url,
      embeddingModel: EMBED,
      dimensions: DIMS,
    });

    // Everything gone; the migration ledger + prompt registry preserved.
    expect(truncated).not.toContain('cogeto_migrations');
    expect(truncated).not.toContain('prompt_registry');
    expect(await count('memory')).toBe(0);
    expect(await count('task')).toBe(0);
    expect(await count('file_metadata')).toBe(0);
    expect(await count('memory_relation')).toBe(0);
    expect(await qdrantPointCount()).toBe(0);
    expect(await objects.objectExists(keys[0]!)).toBe(false);
    expect(await count('cogeto_migrations')).toBeGreaterThan(0);

    // ── Re-seed yields the same asserted state ─────────────────────────────
    await buildWorld();
    const after = await inspectEndState(tdb.pool, principal.userId);
    expect(after.hardFailures).toHaveLength(0);
    expect(after.memories).toBe(before.memories);
    expect(after.statusCounts).toEqual(before.statusCounts);
    expect(after.tasks).toBe(before.tasks);
    expect(after.contradictionRelations).toBe(before.contradictionRelations);
    expect(after.documentMemories).toBe(before.documentMemories);
  });

  const count = async (table: string): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`,
    );
    return Number(rows[0]?.n ?? '0');
  };
});
