import { eq } from 'drizzle-orm';
import type { Tx } from '../infrastructure/index';
import { ModelGateway } from '../model-gateway/index';
import { memory } from './persistence/tables';
import type { MemoryRow } from './persistence/tables';
import { MemoryStore } from './memory.store';

/**
 * Worker handler for MEMORY_EMBED_JOB_TYPE (S3-B): embeds one memory row —
 * the supersession successor created by an edit. Runs under the idempotency
 * key ('memory', <memory id>, 'memory.embed') inside the job's transaction;
 * same two-store order as pipeline stage 5: row update first, point last.
 * A row deleted before the job runs (review rejection) is a clean no-op.
 */
export async function runMemoryEmbedJob(
  tx: Tx,
  store: MemoryStore,
  gateway: ModelGateway,
  payload: { source_id: string },
): Promise<{ embedded: boolean }> {
  const rows = await tx.select().from(memory).where(eq(memory.id, payload.source_id)).for('update');
  const row = rows[0];
  if (!row || !row.content) return { embedded: false };

  const [vector] = await gateway.embed([row.content]);
  const [updated] = await tx
    .update(memory)
    .set({ embeddingModel: gateway.embeddingModelId(), updatedAt: new Date() })
    .where(eq(memory.id, row.id))
    .returning();
  await store.upsertVectors([updated as MemoryRow], [vector!]);
  return { embedded: true };
}
