import { asc, gt, inArray } from 'drizzle-orm';
import type { Db } from '../infrastructure/index';
import { ModelGateway } from '../model-gateway/index';
import { memory } from './persistence/tables';
import type { MemoryRow } from './persistence/tables';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryStore } from './memory.store';

/**
 * Rebuilds the Qdrant index from Postgres (§A.4: "the reindex command must
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
  /** Qdrant API key (QS-4); forwarded to the client. */
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
  const vectors = new MemoryVectorStore({
    url: options.qdrantUrl,
    apiKey: options.qdrantApiKey,
    embeddingModel: model,
    dimensions: options.dimensions,
    collection: options.collection,
  });
  const store = new MemoryStore(options.db, vectors);
  await vectors.ensureCollection();

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
      `batch of ${rows.length}: ${reusable.length} reused, ${toEmbed.length} re-embedded (model ${model})`,
    );
  }

  // Orphan sweep: a point whose row is gone (rolled-back pipeline attempt,
  // pre-saga deletion) is index noise — Postgres is the truth (§A.4).
  const orphans = (await vectors.listPointIds()).filter((id) => !embeddableIds.has(id));
  await vectors.deletePoints(orphans);
  report.orphansRemoved = orphans.length;
  if (orphans.length > 0) log(`removed ${orphans.length} orphan point(s)`);

  report.pointCount = await vectors.count();
  report.ok = report.pointCount === report.embeddable;
  return report;
}
