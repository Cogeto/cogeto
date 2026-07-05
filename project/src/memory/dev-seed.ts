import { createHash, randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import type { Db } from '../infrastructure/index';
import { deletionReceipt, fileMetadata } from './persistence/tables';
import type { MemoryRow } from './persistence/tables';
import { MemoryObjectStore } from './persistence/object-store';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryStore } from './memory.store';
import { parseReceiptCounts } from './deletion-saga';
import type { QdrantOptions } from './factory';

/**
 * DEV/TEST-ONLY fixture — file upload does not exist until O1, but the saga's
 * object-deletion leg must be exercisable today: one object in MinIO, its
 * file_metadata row, and one derived memory (provenance source_type 'file',
 * source_id = object key). Used by the seed:object script (excluded from
 * production images) and the deletion_cascade test. Never called by
 * application code.
 */

export interface SeedObjectOptions {
  db: Db;
  store: MemoryStore;
  objects: MemoryObjectStore;
  principal: Principal;
  content?: string;
}

export interface SeededObject {
  objectKey: string;
  memory: MemoryRow;
}

export async function seedObjectFixture(options: SeedObjectOptions): Promise<SeededObject> {
  const { db, store, objects, principal } = options;
  const bytes = Buffer.from(
    options.content ??
      `Cogeto dev fixture object seeded ${new Date().toISOString()} for ${principal.userId}`,
    'utf8',
  );
  // Object key contract (§A.6): tenant/user/scope/file-{uuid}, tenant = org id.
  const objectKey = `${principal.orgId}/${principal.userId}/private/file-${randomUUID()}`;

  await objects.putObject(objectKey, bytes);
  await db.insert(fileMetadata).values({
    objectKey,
    ownerId: principal.userId,
    scope: 'private',
    sensitive: false,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  });
  const memory = await store.createFromFact(principal, {
    content: 'Seeded fixture fact: this memory derives from the seeded dev object.',
    scope: 'private',
    sourceType: 'file',
    sourceId: objectKey,
    entities: [],
  });
  return { objectKey, memory };
}

export interface SeedOrphanOptions {
  db: Db;
  qdrant: QdrantOptions;
}

export interface SeededOrphan {
  receiptId: string;
  pointId: string;
}

/**
 * DEV/TEST-ONLY orphan drill: plants a stray Qdrant point whose id matches an
 * identifier a CONFIRMED receipt promised gone — exactly the discrepancy the
 * nightly sweep exists to catch (§A.7 step 4). Returns null when no confirmed
 * receipt with enumerated points exists yet (delete something first).
 */
export async function seedOrphanPoint(options: SeedOrphanOptions): Promise<SeededOrphan | null> {
  const rows = await options.db
    .select()
    .from(deletionReceipt)
    .where(eq(deletionReceipt.status, 'confirmed'))
    .orderBy(desc(sql`counts_json->>'enumerated_at'`));
  const receipt = rows.find((row) => parseReceiptCounts(row.countsJson).point_ids.length > 0);
  if (!receipt) return null;

  const counts = parseReceiptCounts(receipt.countsJson);
  const pointId = counts.point_ids[0]!;
  const vectors = new MemoryVectorStore(options.qdrant);
  await vectors.ensureCollection();
  // A recognizable dummy vector — the sweep checks presence, never similarity.
  const vector = Array.from({ length: vectors.dimensions }, (_, i) => (i === 0 ? 1 : 0));
  await vectors.upsert([
    {
      id: pointId,
      vector,
      payload: {
        owner_id: 'orphan-drill',
        scope: 'private',
        status: 'active',
        sensitive: false,
        source_type: counts.source.type,
        source_id: counts.source.id,
        valid_until: null,
      },
    },
  ]);
  return { receiptId: receipt.id, pointId };
}
