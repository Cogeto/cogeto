import { and, isNotNull, ne } from 'drizzle-orm';
import type { Db } from '../infrastructure/index';
import { memory } from './persistence/tables';
import { dimensionsFor, MemoryVectorStore } from './persistence/vector-store';

/**
 * Embedding-space integrity (decision 0040 ruling 3): `memory.embedding_model`
 * records each vector's producer (decision 0005 r3). Serving with vectors from
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
 * The DIMENSION half of the guard (decision 0041 ruling 5): the model-name
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
