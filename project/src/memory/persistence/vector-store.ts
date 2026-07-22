import { QdrantClient } from '@qdrant/js-client-rest';
import type { MemoryScope, MemoryStatus, Principal } from '@cogeto/shared';

/**
 * The Qdrant side of the memory module's storage (decision 0003 ruling 2: the
 * memory module owns ALL storage access, including the Qdrant client — this
 * file is module-private and the only place in the system that imports the
 * Qdrant client, enforced by dependency-cruiser).
 *
 * Contract (§A.4): Postgres is the source of truth; this collection is a
 * rebuildable index. Point id = memory id; the payload carries copies of the
 * gate and filter fields so scope/sensitive are enforced INSIDE the vector
 * query, never by app-side post-filtering.
 */

export const MEMORY_COLLECTION = 'memories';

/**
 * Vector size per embed model; reindex re-embeds when the model changes.
 * Every embeddings model a provider preset can select MUST have an explicit
 * entry (issue #177: a missing entry silently fell back to 1024 and OpenAI's
 * 1536-dim vectors failed at upsert) — `embedding_dimensions_cover_presets`
 * enforces this.
 */
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  'mistral-embed': 1024,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};
const DEFAULT_DIMENSIONS = 1024;

export function dimensionsFor(embeddingModel: string): number {
  return EMBEDDING_DIMENSIONS[embeddingModel] ?? DEFAULT_DIMENSIONS;
}

export interface MemoryPointPayload {
  owner_id: string;
  scope: MemoryScope;
  status: MemoryStatus;
  sensitive: boolean;
  source_type: string;
  source_id: string;
  valid_until: string | null;
  [key: string]: unknown; // satisfies the client's payload record type
}

export interface MemoryPoint {
  /** The memory row's uuid. Upsert by this id is what makes retries safe. */
  id: string;
  vector: number[];
  payload: MemoryPointPayload;
}

export interface VectorHit {
  id: string;
  /** Raw Qdrant cosine similarity, in [-1, 1]. */
  score: number;
}

interface FieldMatch {
  key: string;
  /** Exact value, or any-of for status allowlists (0010 ruling 6). */
  match: { value: string | boolean } | { any: string[] };
}
/** A Qdrant condition may itself be a nested filter — used for OR-gates. */
export interface GateFilter {
  must: (FieldMatch | { should: FieldMatch[] })[];
}

/**
 * The scope + sensitive gates as a native Qdrant payload pre-filter — the
 * exact mirror of MemoryStore.visibleTo (§A.4/§A.5; 0003 ruling 3):
 * - scope: own rows OR scope = shared;
 * - sensitive: excluded by default; with explicit opt-in, still owner-only.
 * Pure and exported so tests can assert the filter itself, not just behavior.
 */
export function buildGateFilter(
  principal: Principal,
  opts: { includeSensitive?: boolean } = {},
): GateFilter {
  const ownRows: FieldMatch = { key: 'owner_id', match: { value: principal.userId } };
  const scopeGate = { should: [ownRows, { key: 'scope', match: { value: 'shared' } }] };
  const notSensitive: FieldMatch = { key: 'sensitive', match: { value: false } };
  const sensitiveGate = opts.includeSensitive ? { should: [notSensitive, ownRows] } : notSensitive;
  return { must: [scopeGate, sensitiveGate] };
}

export interface MemoryVectorStoreOptions {
  url: string;
  embeddingModel: string;
  /** Qdrant API key (QS-4). Sent as the `api-key` header on every request; the
   * default compose stack keeps Qdrant internal with no key. */
  apiKey?: string;
  /** Test override; production derives from the embed model. */
  dimensions?: number;
  collection?: string;
}

export class MemoryVectorStore {
  private readonly client: QdrantClient;
  readonly collection: string;
  readonly dimensions: number;
  readonly embeddingModel: string;

  constructor(options: MemoryVectorStoreOptions) {
    this.client = new QdrantClient({ url: options.url, apiKey: options.apiKey });
    this.collection = options.collection ?? MEMORY_COLLECTION;
    this.embeddingModel = options.embeddingModel;
    this.dimensions = options.dimensions ?? dimensionsFor(options.embeddingModel);
  }

  /** Idempotent: safe to run on every worker boot. */
  async ensureCollection(): Promise<void> {
    const { exists } = await this.client.collectionExists(this.collection);
    if (!exists) {
      await this.client.createCollection(this.collection, {
        vectors: { size: this.dimensions, distance: 'Cosine' },
      });
    }
    // Payload indexes on the gate/filter fields (§A.4). Re-creation is a no-op.
    const indexes: { field: string; schema: 'keyword' | 'bool' }[] = [
      { field: 'owner_id', schema: 'keyword' },
      { field: 'scope', schema: 'keyword' },
      { field: 'status', schema: 'keyword' },
      { field: 'sensitive', schema: 'bool' },
    ];
    for (const { field, schema } of indexes) {
      await this.client
        .createPayloadIndex(this.collection, {
          field_name: field,
          field_schema: schema,
          wait: true,
        })
        .catch((error: unknown) => {
          if (!String(error).toLowerCase().includes('already exists')) throw error;
        });
    }
  }

  async upsert(points: MemoryPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.client.upsert(this.collection, { wait: true, points });
  }

  async search(vector: number[], filter: GateFilter, limit: number): Promise<VectorHit[]> {
    const results = await this.client.search(this.collection, {
      vector,
      limit,
      filter,
      with_payload: false,
    });
    return results.map((r) => ({ id: String(r.id), score: r.score }));
  }

  /** Existing vectors by memory id — the reindex reuse path. */
  async retrieveVectors(ids: string[]): Promise<Map<string, number[]>> {
    if (ids.length === 0) return new Map();
    const points = await this.client.retrieve(this.collection, {
      ids,
      with_payload: false,
      with_vector: true,
    });
    const found = new Map<string, number[]>();
    for (const point of points) {
      if (Array.isArray(point.vector)) found.set(String(point.id), point.vector as number[]);
    }
    return found;
  }

  async count(): Promise<number> {
    const { count } = await this.client.count(this.collection, { exact: true });
    return count;
  }

  /** All point ids, paged — reindex uses this for the orphan sweep. */
  async listPointIds(): Promise<string[]> {
    const ids: string[] = [];
    let offset: string | number | undefined | null = undefined;
    do {
      const page = await this.client.scroll(this.collection, {
        limit: 256,
        offset: offset ?? undefined,
        with_payload: false,
        with_vector: false,
      });
      for (const point of page.points) ids.push(String(point.id));
      offset = page.next_page_offset as string | number | null;
    } while (offset !== null && offset !== undefined);
    return ids;
  }

  /**
   * Updates the payload copy of gate/filter fields on an existing point —
   * how status/sensitive changes propagate to the index (S3-B). Idempotent;
   * a missing point (row not yet embedded) is a no-op, not an error.
   */
  async setPayload(id: string, payload: Partial<MemoryPointPayload>): Promise<void> {
    try {
      await this.client.setPayload(this.collection, { points: [id], payload, wait: true });
    } catch (error) {
      // Qdrant 404s on a missing point; the no-op contract above is what the
      // two-store write paths (toggleSensitive, supersedeCore) rely on for
      // not-yet-embedded memories. Anything else is a real failure.
      if (!/not found/i.test(String(error))) throw error;
    }
  }

  /** Payloads by memory id — the toggle test's assertion surface. */
  async retrievePayloads(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    if (ids.length === 0) return new Map();
    const points = await this.client.retrieve(this.collection, {
      ids,
      with_payload: true,
      with_vector: false,
    });
    const found = new Map<string, Record<string, unknown>>();
    for (const point of points) {
      if (point.payload) found.set(String(point.id), point.payload);
    }
    return found;
  }

  async deletePoints(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.delete(this.collection, { wait: true, points: ids });
  }

  async deleteCollectionIfExists(): Promise<void> {
    const { exists } = await this.client.collectionExists(this.collection);
    if (exists) await this.client.deleteCollection(this.collection);
  }
}
