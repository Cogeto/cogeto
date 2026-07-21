import { and, isNotNull, ne } from 'drizzle-orm';
import type { Db } from '../infrastructure/index';
import { memory } from './persistence/tables';

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
