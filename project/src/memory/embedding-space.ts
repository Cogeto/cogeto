import { and, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../infrastructure/index';
import { memory } from './persistence/tables';
import { dimensionsFor, MemoryVectorStore } from './persistence/vector-store';
import { readEmbeddingIndexState, resolveActiveIndex } from './embedding-index';

/**
 * Embedding-space integrity: `memory.embedding_model`
 * records each vector's producer (r3). Serving with vectors from
 * a DIFFERENT model than the active one silently mixes embedding spaces, so
 * boot refuses until `npm run reindex` re-embeds them. Recall-only rows
 * (`embedding_model IS NULL`) never block.
 */
export async function listForeignEmbeddingModels(db: Db, activeModel: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ model: memory.embeddingModel })
    .from(memory)
    .where(and(isNotNull(memory.embeddingModel), ne(memory.embeddingModel, activeModel)));
  return rows
    .map((row) => row.model)
    .filter((model): model is string => model !== null)
    .sort();
}

/**
 * The DIMENSION half of the guard: the model-name
 * check above cannot see a collection whose vector size disagrees with the
 * active model (a half-finished migration, a restored snapshot). Returns the
 * disagreement, or null when consistent — a missing/empty collection is
 * consistent by definition (boot creates it at the right size). Qdrant stays
 * module-private: callers pass primitives, never a client.
 */
export async function vectorIndexDimensionMismatch(options: {
  url: string;
  apiKey?: string;
  embeddingModel: string;
  collection?: string;
}): Promise<{ expected: number; actual: number } | null> {
  const store = new MemoryVectorStore({
    url: options.url,
    apiKey: options.apiKey,
    embeddingModel: options.embeddingModel,
    collection: options.collection,
  });
  const actual = await store.indexDimensions();
  const expected = dimensionsFor(options.embeddingModel);
  if (actual === null || actual === expected) return null;
  return { expected, actual };
}

/**
 * The whole boot guard in one state-aware check (V2.4 item 7.1 second half).
 *
 * With the managed rebuild, no INTERFACE action can produce a mismatch: the
 * pending model lives beside the active one and nothing flips until the new
 * index is verified complete, in one transaction. This guard therefore stays
 * as a NET for states produced by other means — a direct database edit, a
 * restored backup whose index and configuration disagree — and it must know
 * the two legitimate in-flight states:
 *
 *  - a RUNNING (or failed) rebuild is coherent: rows and the active
 *    collection still match the active model, and the target collection is
 *    invisible to serving;
 *  - a freshly switched instance may briefly hold rows stamped with the OLD
 *    model in no rows at all — the switch stamps in the same transaction, so
 *    that state never exists; nothing special to allow.
 *
 * Returns a structured problem so the entrypoint can render an actionable
 * message: what mismatched, what the active and index configurations are, and
 * the operator command that resolves it.
 */
export interface EmbeddingSpaceProblem {
  kind: 'foreign_models' | 'dimension_mismatch';
  activeModel: string;
  activeCollection: string;
  /** foreign_models: every stored producer that is not the active model,
   * with how many rows each stamped. */
  foreign?: { model: string; rows: number }[];
  /** dimension_mismatch: what the collection holds vs what the model makes. */
  expected?: number;
  actual?: number;
}

export async function checkEmbeddingSpace(
  db: Db,
  options: { url: string; apiKey?: string; activeModel: string },
): Promise<EmbeddingSpaceProblem | null> {
  const state = await readEmbeddingIndexState(db);
  const active = resolveActiveIndex(state, options.activeModel);

  // A row stamped by any model other than the active one refuses, even
  // mid-rebuild: during 'running' every row still carries the OLD (active)
  // model, and the switch stamps rows and flips the assignment in one
  // transaction, so no rebuild state legitimately shows foreign stamps.
  const rows = (await db
    .select({ model: memory.embeddingModel, count: sql<number>`count(*)::int` })
    .from(memory)
    .where(and(isNotNull(memory.embeddingModel), ne(memory.embeddingModel, options.activeModel)))
    .groupBy(memory.embeddingModel)) as { model: string | null; count: number }[];
  const foreign = rows
    .filter((row): row is { model: string; count: number } => row.model !== null)
    .map((row) => ({ model: row.model, rows: row.count }))
    .sort((a, b) => a.model.localeCompare(b.model));
  if (foreign.length > 0) {
    return {
      kind: 'foreign_models',
      activeModel: options.activeModel,
      activeCollection: active.collection,
      foreign,
    };
  }

  const store = new MemoryVectorStore({
    url: options.url,
    apiKey: options.apiKey,
    embeddingModel: options.activeModel,
    collection: active.collection,
    dimensions: active.dimensions,
  });
  const actual = await store.indexDimensions();
  if (actual !== null && actual !== active.dimensions) {
    return {
      kind: 'dimension_mismatch',
      activeModel: options.activeModel,
      activeCollection: active.collection,
      expected: active.dimensions,
      actual,
    };
  }
  return null;
}
