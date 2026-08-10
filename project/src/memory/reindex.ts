import { and, asc, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../infrastructure/index';
import { ModelGateway } from '../model-gateway/index';
import { memory } from './persistence/tables';
import type { MemoryRow } from './persistence/tables';
import { MemoryVectorStore, registryDimensionsFor } from './persistence/vector-store';
import { MemoryStore } from './memory.store';
import {
  readEmbeddingIndexState,
  resolveActiveIndex,
  updateEmbeddingIndexState,
} from './embedding-index';

/**
 * Rebuilds the Qdrant index from Postgres (spec §4.2: "the reindex command must
 * always work" — the disaster-recovery and migration path in one). Owned by
 * the memory module (0003 ruling 2); entrypoints call this function and never
 * see a Qdrant type.
 *
 * Re-embeds only where required: a row whose stored embedding_model matches
 * the configured model AND whose point still holds a vector is reused;
 * everything else goes back through the gateway.
 */

export interface ReindexOptions {
  db: Db;
  gateway: ModelGateway;
  qdrantUrl: string;
  /** Qdrant API key; forwarded to the client. */
  qdrantApiKey?: string;
  /** Defaults to the gateway's configured embedding model. */
  embeddingModel?: string;
  /** Test override for the collection's vector size. */
  dimensions?: number;
  collection?: string;
  batchSize?: number;
  log?: (message: string) => void;
}

export interface ReindexReport {
  totalMemories: number;
  /** Rows with non-empty content — the only ones that can carry a vector. */
  embeddable: number;
  reused: number;
  reembedded: number;
  skippedNoContent: number;
  /** Points whose memory row no longer exists — removed (index, not truth). */
  orphansRemoved: number;
  pointCount: number;
  /** pointCount === embeddable; the command exits nonzero when false. */
  ok: boolean;
}

export async function reindexMemories(options: ReindexOptions): Promise<ReindexReport> {
  const log = options.log ?? (() => undefined);
  const model = options.embeddingModel ?? options.gateway.embeddingModelId();
  const batchSize = options.batchSize ?? 64;
  // The ACTIVE collection is state since migration 0053: a post-switch
  // instance no longer serves from 'memories', and an in-place repair must
  // rebuild the collection actually being served. Explicit options still win
  // (tests, tools addressing a specific collection).
  const state = await readEmbeddingIndexState(options.db);
  const active = resolveActiveIndex(state, model);
  if (!options.collection && state.rebuildStatus) {
    throw new Error(
      'a managed embedding rebuild is in progress; let it finish or cancel it before an ' +
        'in-place reindex',
    );
  }
  // A registry-known model answers its own dimension; an arbitrary model's
  // TRUE dimension is what it returns, so probe one embedding for those. A
  // keyless run (reuse-only repair) falls back to the recorded state, which
  // is the registry answer on a pre-0053 instance.
  let dimensions = options.dimensions;
  if (dimensions === undefined && !options.collection) {
    dimensions = registryDimensionsFor(model);
    if (dimensions === undefined) {
      try {
        dimensions = (await options.gateway.embed(['probe']))[0]?.length || active.dimensions;
      } catch {
        dimensions = active.dimensions;
      }
    }
  }
  const vectors = new MemoryVectorStore({
    url: options.qdrantUrl,
    apiKey: options.qdrantApiKey,
    embeddingModel: model,
    dimensions,
    collection: options.collection ?? active.collection,
  });
  const store = new MemoryStore(options.db, vectors);
  // Reindex is the rebuild path (spec §4.2): an embeddings-model switch with a new
  // vector size drops and recreates the collection here.
  await vectors.ensureCollection({ recreateOnDimensionMismatch: true });

  const report: ReindexReport = {
    totalMemories: 0,
    embeddable: 0,
    reused: 0,
    reembedded: 0,
    skippedNoContent: 0,
    orphansRemoved: 0,
    pointCount: 0,
    ok: false,
  };
  const embeddableIds = new Set<string>();

  // Progress denominator: a full local reindex takes
  // real wall-clock, so every batch reports done/total, not just batch sizes.
  const [{ total }] = (await options.db
    .select({ total: sql<number>`count(*)::int` })
    .from(memory)
    .where(and(isNotNull(memory.content), sql`btrim(${memory.content}) <> ''`))) as [
    { total: number },
  ];

  // Streamed via keyset pagination on the primary key — bounded memory
  // however large the table grows.
  let afterId: string | null = null;
  for (;;) {
    const rows: MemoryRow[] = await options.db
      .select()
      .from(memory)
      .where(afterId ? gt(memory.id, afterId) : undefined)
      .orderBy(asc(memory.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.id;

    report.totalMemories += rows.length;
    const embeddable = rows.filter((row) => row.content && row.content.trim().length > 0);
    report.skippedNoContent += rows.length - embeddable.length;
    report.embeddable += embeddable.length;
    for (const row of embeddable) embeddableIds.add(row.id);
    if (embeddable.length === 0) continue;

    // Reuse path: same model recorded AND the point still holds its vector.
    const reuseCandidates = embeddable.filter((row) => row.embeddingModel === model);
    const existing = await vectors.retrieveVectors(reuseCandidates.map((row) => row.id));
    const reusable = embeddable.filter((row) => existing.has(row.id));
    const toEmbed = embeddable.filter((row) => !existing.has(row.id));

    const freshVectors = await options.gateway.embed(toEmbed.map((row) => row.content as string));
    if (toEmbed.length > 0) {
      await options.db
        .update(memory)
        .set({ embeddingModel: model, updatedAt: new Date() })
        .where(
          inArray(
            memory.id,
            toEmbed.map((row) => row.id),
          ),
        );
    }

    await store.upsertVectors(
      [...reusable, ...toEmbed],
      [...reusable.map((row) => existing.get(row.id)!), ...freshVectors],
    );
    report.reused += reusable.length;
    report.reembedded += toEmbed.length;
    log(
      `progress ${report.reused + report.reembedded}/${total}: batch of ${rows.length}, ` +
        `${reusable.length} reused, ${toEmbed.length} re-embedded (model ${model})`,
    );
  }

  // Orphan sweep: a point whose row is gone (rolled-back pipeline attempt,
  // pre-saga deletion) is index noise — Postgres is the truth (spec §4.2).
  const orphans = (await vectors.listPointIds()).filter((id) => !embeddableIds.has(id));
  await vectors.deletePoints(orphans);
  report.orphansRemoved = orphans.length;
  if (orphans.length > 0) log(`removed ${orphans.length} orphan point(s)`);

  report.pointCount = await vectors.count();
  report.ok = report.pointCount === report.embeddable;
  // Record what the repaired index actually is (migration 0053): the guard's
  // dimension half compares against this, so a repair that probed the model's
  // real dimension leaves the state telling the same truth.
  if (report.ok && !options.collection) {
    await updateEmbeddingIndexState(options.db, {
      activeDimensions: vectors.dimensions,
    });
  }
  return report;
}
