import { QdrantClient } from '@qdrant/js-client-rest';
import type { MemoryScope, MemoryStatus, Principal } from '@cogeto/shared';

/**
 * The Qdrant side of the memory module's storage (: the
 * memory module owns ALL storage access, including the Qdrant client — this
 * file is module-private and the only place in the system that imports the
 * Qdrant client, enforced by dependency-cruiser).
 *
 * Contract (spec §4.2): Postgres is the source of truth; this collection is a
 * rebuildable index. Point id = memory id; the payload carries copies of the
 * gate and filter fields so scope/sensitive are enforced INSIDE the vector
 * query, never by app-side post-filtering.
 */

export const MEMORY_COLLECTION = 'memories';

/**
 * How many source ids the project retrieval lens (V2.5 item 8.3) will push
 * into the vector query as a `source_id` match-any pre-filter. Above it the
 * pre-filter is skipped and the Postgres row resolution filters exactly on
 * the full (source_type, source_id) pair instead: a recall cost inside a very
 * large project, never a correctness one, and never a gate. Stated in
 * docs/features/projects.md rather than hidden.
 */
export const LENS_VECTOR_FILTER_CAP = 512;

/**
 * Vector size per embed model; reindex re-embeds when the model changes.
 * Every embeddings model a provider preset can select MUST have an explicit
 * entry (: a missing entry silently fell back to 1024 and OpenAI's
 * 1536-dim vectors failed at upsert)`embedding_dimensions_cover_presets`
 * enforces this.
 */
const EMBEDDING_DIMENSIONS: Record<string, number> = {
  'mistral-embed': 1024,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  // Local multilingual embeddings via Ollama.
  'bge-m3': 1024,
};
const DEFAULT_DIMENSIONS = 1024;

export function dimensionsFor(embeddingModel: string): number {
  return registryDimensionsFor(embeddingModel) ?? DEFAULT_DIMENSIONS;
}

/** The registry's answer WITHOUT the fallback — undefined means "unknown
 * model", where the honest dimension comes from a real probed embedding
 * (the managed rebuild and the in-place reindex both do exactly that). */
export function registryDimensionsFor(embeddingModel: string): number | undefined {
  // Ollama model names may carry a `:tag` suffix (`bge-m3:latest`); the
  // dimension is a property of the base model.
  const base = embeddingModel.split(':')[0]!;
  return EMBEDDING_DIMENSIONS[embeddingModel] ?? EMBEDDING_DIMENSIONS[base];
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

/**
 * A row's Qdrant point, gate payload included. ONE construction shared by the
 * store's upsert path and the managed rebuild, so a rebuilt collection cannot
 * carry fewer gate fields than the serving one — the parity is structural,
 * not copied.
 */
export function memoryPointFor(
  row: {
    id: string;
    ownerId: string;
    scope: MemoryScope;
    status: MemoryStatus;
    sensitive: boolean;
    sourceType: string;
    sourceId: string;
    validUntil: Date | null;
  },
  vector: number[],
): MemoryPoint {
  return {
    id: row.id,
    vector,
    payload: {
      owner_id: row.ownerId,
      scope: row.scope,
      status: row.status,
      sensitive: row.sensitive,
      source_type: row.sourceType,
      source_id: row.sourceId,
      valid_until: row.validUntil?.toISOString() ?? null,
    },
  };
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
 * exact mirror of MemoryStore.visibleTo (spec §4.2/spec §3.4; 0003 ruling 3)
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

/**
 * Live resolution of the ACTIVE collection (V2.4 item 7.1 second half). The
 * managed rebuild switches collections without a restart, so a long-lived
 * store cannot bake the name in at construction: it re-reads the state row
 * whenever the model-configuration version moves (the same version the
 * reloading gateway watches, so the query embedding and the collection it is
 * searched against flip together). `gateSyncTargets` is deliberately UNCACHED:
 * a scope/status/sensitive payload write or a point deletion during a rebuild
 * must reach the half-built target collection too, and a rebuild begins
 * without a version bump.
 */
export interface LiveIndexBinding {
  versionOf: () => number;
  read: () => Promise<{ collection: string; dimensions: number }>;
  /** Every collection a gate write or deletion must reach right now. */
  gateSyncTargets: () => Promise<string[]>;
}

export interface MemoryVectorStoreOptions {
  url: string;
  embeddingModel: string;
  /** Qdrant API key. Sent as the `api-key` header on every request; the
   * default compose stack keeps Qdrant internal with no key. */
  apiKey?: string;
  /** Test override; production derives from the embed model. */
  dimensions?: number;
  collection?: string;
  /** Live collection resolution; absent (tests, CLI views) keeps the fixed
   * constructor values, which is the pre-0053 behaviour exactly. */
  liveIndex?: LiveIndexBinding;
}

export class MemoryVectorStore {
  private readonly client: QdrantClient;
  private currentCollection: string;
  private currentDimensions: number;
  readonly embeddingModel: string;
  private readonly liveIndex?: LiveIndexBinding;
  private syncedVersion = Number.NEGATIVE_INFINITY;

  constructor(options: MemoryVectorStoreOptions, client?: QdrantClient) {
    this.client = client ?? new QdrantClient({ url: options.url, apiKey: options.apiKey });
    this.currentCollection = options.collection ?? MEMORY_COLLECTION;
    this.embeddingModel = options.embeddingModel;
    this.currentDimensions = options.dimensions ?? dimensionsFor(options.embeddingModel);
    this.liveIndex = options.liveIndex;
  }

  get collection(): string {
    return this.currentCollection;
  }

  get dimensions(): number {
    return this.currentDimensions;
  }

  /** A fixed view over another collection, sharing the client — how the
   * rebuild engine addresses its target while this store keeps serving. */
  view(collection: string, dimensions: number): MemoryVectorStore {
    return new MemoryVectorStore(
      { url: '', embeddingModel: this.embeddingModel, collection, dimensions },
      this.client,
    );
  }

  /** Re-resolve the active collection when the configuration version moved. */
  private async sync(): Promise<void> {
    if (!this.liveIndex) return;
    const version = this.liveIndex.versionOf();
    if (version === this.syncedVersion) return;
    const active = await this.liveIndex.read();
    this.currentCollection = active.collection;
    this.currentDimensions = active.dimensions;
    this.syncedVersion = version;
  }

  /**
   * Idempotent: safe to run on every worker boot. Reindex passes
   * `recreateOnDimensionMismatch`: an embeddings-model switch with
   * a different vector size must DROP and recreate the collection — Postgres is
   * the truth and this index is rebuildable (spec §4.2) — or every upsert fails with
   * a dimension error. Normal boot keeps create-if-missing semantics.
   */
  async ensureCollection(options: { recreateOnDimensionMismatch?: boolean } = {}): Promise<void> {
    await this.sync();
    let { exists } = await this.client.collectionExists(this.collection);
    if (exists && options.recreateOnDimensionMismatch) {
      const current = await this.indexDimensions();
      if (current !== null && current !== this.dimensions) {
        await this.client.deleteCollection(this.collection);
        exists = false;
      }
    }
    if (!exists) {
      await this.client.createCollection(this.collection, {
        vectors: { size: this.dimensions, distance: 'Cosine' },
      });
    }
    // Payload indexes on the gate/filter fields (spec §4.2). Re-creation is a no-op.
    const indexes: { field: string; schema: 'keyword' | 'bool' }[] = [
      { field: 'owner_id', schema: 'keyword' },
      { field: 'scope', schema: 'keyword' },
      { field: 'status', schema: 'keyword' },
      { field: 'sensitive', schema: 'bool' },
      // Not a gate field: the project retrieval lens's narrowing pre-filter
      // (V2.5 item 8.3). Indexed for the same reason the others are — an
      // unindexed match-any would scan the collection.
      { field: 'source_id', schema: 'keyword' },
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

  /** The existing collection's vector size, or null when unreadable/absent —
   * public for the boot-time dimension guard. */
  async indexDimensions(): Promise<number | null> {
    try {
      const info = await this.client.getCollection(this.collection);
      const vectors = info.config?.params?.vectors as { size?: unknown } | undefined;
      return typeof vectors?.size === 'number' ? vectors.size : null;
    } catch {
      return null;
    }
  }

  async upsert(points: MemoryPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.sync();
    await this.client.upsert(this.collection, { wait: true, points });
  }

  async search(vector: number[], filter: GateFilter, limit: number): Promise<VectorHit[]> {
    await this.sync();
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
    await this.sync();
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
    await this.sync();
    const { count } = await this.client.count(this.collection, { exact: true });
    return count;
  }

  /** All point ids, paged — reindex uses this for the orphan sweep. */
  async listPointIds(): Promise<string[]> {
    await this.sync();
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
   * how status/sensitive changes propagate to the index. Idempotent;
   * a missing point (row not yet embedded) is a no-op, not an error.
   *
   * During a managed rebuild this applies to EVERY gate-sync target: a
   * sensitive toggle that reached only the serving collection would surface
   * the fact again the moment the rebuilt collection took over, which is a
   * gate regression, not a staleness bug. The rebuild's final quiesced resync
   * is the belt behind this best-effort dual apply.
   */
  async setPayload(id: string, payload: Partial<MemoryPointPayload>): Promise<void> {
    for (const collection of await this.writeTargets()) {
      try {
        await this.client.setPayload(collection, { points: [id], payload, wait: true });
      } catch (error) {
        // Qdrant 404s on a missing point; the no-op contract above is what the
        // two-store write paths (toggleSensitive, supersedeCore) rely on for
        // not-yet-embedded memories. Anything else is a real failure.
        if (!/not found/i.test(String(error))) throw error;
      }
    }
  }

  /** Every collection a gate write or deletion must reach right now: the
   * active collection, plus a live rebuild's target. Read fresh, not cached —
   * a rebuild begins without a configuration-version bump. */
  private async writeTargets(): Promise<string[]> {
    if (!this.liveIndex) return [this.collection];
    const targets = await this.liveIndex.gateSyncTargets();
    await this.sync();
    return targets.length > 0 ? targets : [this.collection];
  }

  /** Payloads by memory id — the toggle test's assertion surface. */
  async retrievePayloads(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    if (ids.length === 0) return new Map();
    await this.sync();
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

  /**
   * Deletion reaches every gate-sync target: a deletion receipt confirms the
   * identifiers left the vector store, and a point surviving in a half-built
   * rebuild collection would resurface after the switch — the exact promise
   * receipts exist to keep. A missing collection cannot hold the point and is
   * skipped (a rebuild cancelled between the target read and this call).
   */
  async deletePoints(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const collection of await this.writeTargets()) {
      try {
        await this.client.delete(collection, { wait: true, points: ids });
      } catch (error) {
        if (!/not found|doesn't exist|not exist/i.test(String(error))) throw error;
      }
    }
  }

  async deleteCollectionIfExists(): Promise<void> {
    const { exists } = await this.client.collectionExists(this.collection);
    if (exists) await this.client.deleteCollection(this.collection);
  }

  /** Every collection on the server — the integrity sweep's stray-rebuild-
   * collection arm, and the switch's retirement of the replaced one. */
  async listCollectionNames(): Promise<string[]> {
    const { collections } = await this.client.getCollections();
    return collections.map((entry) => entry.name);
  }
}
