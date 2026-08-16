import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { MemoriesController } from './memories.controller';
import { RelationsController } from './relations.controller';
import { SourcesController } from './sources.controller';
import {
  IntegrityController,
  RECEIPTS_ADMIN_ROLE,
  ReceiptsController,
} from './receipts.controller';
import { InstanceController } from './instance.controller';
import { OwnerErasureController } from './erasure.controller';
import { OwnerErasureService } from './owner-erasure.service';
import { TimelineController } from './timeline.controller';
import { IntegritySweep } from './integrity-sweep';
import { MemoryStore } from './memory.store';
import { MemorySystemStore } from './memory-system.store';
import { TimelineService } from './timeline.service';
import { MemoryReconciliation } from './reconciliation';
import {
  DELETION_SAGA_OPTIONS,
  DeletionExecutor,
  DeletionSaga,
  DERIVED_CASCADES,
  INGESTION_GUARD,
  INSTANCE_KEY_DIR,
  SOURCE_DELETIONS,
} from './deletion-saga';
import type {
  DeletionSagaOptions,
  DerivedCascade,
  IngestionGuard,
  SourceDeletion,
} from './deletion-saga';
import { SWEEP_OPTIONS } from './integrity-sweep';
import type { SweepOptions } from './integrity-sweep';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { MemoryFileStore } from './file-store';
import { liveIndexBinding } from './embedding-index';
import { EmbeddingRebuildService } from './embedding-rebuild.service';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { MEMORY_ELIGIBILITY_HOOK } from './eligibility-hook';
import type { MemoryEligibilityHook } from './eligibility-hook';

export interface MemoryModuleOptions {
  qdrantUrl: string;
  /** Qdrant API key; forwarded to the client. */
  qdrantApiKey?: string;
  /** Determines the collection's vector size; recorded per memory. */
  embeddingModel: string;
  /** Test override for the vector size. */
  dimensions?: number;
  /**
   * The LIVE model configuration object (V2.4 item 7.1, mutated in place on
   * reload). When present, the vector store resolves the active collection
   * from the embedding_index_state row and re-resolves whenever the
   * configuration version moves, which is what lets a managed rebuild switch
   * collections without a restart. Absent (tests, bare harnesses) the store
   * keeps its constructor-fixed collection, the pre-0053 behaviour.
   */
  modelProviders?: { version: number; tiers: { embedding: { model: string } } };
  /** Object storage — the saga's byte-deletion leg + encryption check (0008);
   * `publicUrl` is the browser-reachable origin for presigned URLs (O1). */
  s3: { url: string; publicUrl?: string; accessKey: string; secretKey: string; bucket: string };
  /** Where the instance signing keypair lives (spec §11.1). */
  instanceKeyDir: string;
  /**
   * Source-deletion adapters for source rows owned by other modules — bound by
   * the composition root, mirroring ingestion's SourceReader port (spec §15).
   */
  sourceDeletions?: { imports?: ModuleMetadata['imports']; adapters: Type<SourceDeletion>[] };
  /**
   * The eligibility port (V2.3 item 6.1): fired when the owner confirms an
   * `uncertain` fact, which admits it to the contradiction candidate pool.
   * Implemented by ingestion (ReconcileRepairEligibilityHook, the repair
   * job's owner); like `ingestionGuard`, the class must be dependency-free
   * beyond global infrastructure, because it is instantiated here. Optional:
   * harnesses and the worker run without it.
   */
  eligibilityHook?: Type<MemoryEligibilityHook>;
  /** Derived-artifact cascades (0013 ruling 6) — chat answers and reply drafts
   * today, bound like the source deletions: memory defines the port, the
   * deriving module implements. */
  derivedCascades?: { imports?: ModuleMetadata['imports']; adapters: Type<DerivedCascade>[] };
  /**
   * Pending-ingestion cancellation for the deletion saga  — REQUIRED so no production wiring can silently ship without the
   * delete-vs-ingestion serialization. Implemented by the ingestion module
   * (PipelineIngestionGuard); must be dependency-free (instantiated here).
   */
  ingestionGuard: Type<IngestionGuard>;
  /**
   * Provide the unscoped machine-read surface, {@link MemorySystemStore}
   * (V2.0 item 3.7). **Worker root only.** The nightly dreaming cycle and the
   * skill runtime read across every owner by nature; the app serves requests
   * and has no such caller, so its injector must not be able to produce one.
   * Omitted (the default) the class is not a provider at all.
   */
  systemReads?: boolean;
  /**
   * The project role that unlocks the INSTANCE-WIDE chain report on
   * `GET /api/receipts/verify` (V2.0 item 3.7); everyone else gets the verdict
   * over their own receipts. Named here rather than read out of the identity
   * seam's options, which are deliberately DI-visible and import-invisible.
   * Absent (worker, harnesses) means nobody is an administrator, and the
   * trimmed answer is the safe direction.
   */
  adminRole?: string;
  /**
   * Serve the administrative owner-erasure route (issue #632). **App root
   * only**, the `systemReads` pattern in the other direction: the worker needs
   * the SERVICE (it runs the pass) but must register no controller, and the
   * route is administrative, so it exists exactly where a request can reach
   * it and nowhere else.
   */
  erasureRoute?: boolean;
}

/**
 * memory — core domain (spec §15).
 * Owns ALL storage access for memory data: the Postgres tables, the Qdrant
 * client AND the object-storage client (module-private — no other module may
 * import them; dependency-cruiser rule). Registered once by each composition
 * root with its storage options.
 *
 * NOT global since B13 closed (V2.0 item 3.6 part 4): each composition root
 * creates ONE instance and threads it through the registration options of
 * every module that injects a memory provider. Globality was the last unnamed
 * dependency in the graph.
 */
@Module({})
export class MemoryModule {
  static register(options: MemoryModuleOptions): DynamicModule {
    // Boot assertion: a production-configured memory module ALWAYS has
    // a vector store — transitions and supersession must fail loudly, never
    // silently skip their Qdrant payload sync, if Qdrant is miswired.
    if (!options.qdrantUrl) {
      throw new Error('MemoryModule.register: qdrantUrl is required, /');
    }
    return {
      module: MemoryModule,
      imports: [
        ...(options.sourceDeletions?.imports ?? []),
        ...(options.derivedCascades?.imports ?? []),
      ],
      controllers: [
        MemoriesController,
        RelationsController,
        SourcesController,
        ReceiptsController,
        IntegrityController,
        TimelineController,
        // The receipts' verification key (V2.0 item 3.6 part 2).
        InstanceController,
        // Owner erasure (issue #632), administrative and app-root only.
        ...(options.erasureRoute ? [OwnerErasureController] : []),
      ],
      providers: [
        {
          provide: MemoryVectorStore,
          useFactory: (db: Db) =>
            new MemoryVectorStore({
              url: options.qdrantUrl,
              apiKey: options.qdrantApiKey,
              embeddingModel: options.embeddingModel,
              dimensions: options.dimensions,
              // An explicit dimensions override (tests) keeps the fixed
              // constructor target; live resolution would clobber it.
              ...(options.modelProviders && options.dimensions === undefined
                ? { liveIndex: liveIndexBinding(db, options.modelProviders) }
                : {}),
            }),
          inject: [DRIZZLE],
        },
        {
          provide: MemoryObjectStore,
          useFactory: () => new MemoryObjectStore(options.s3),
        },
        { provide: INSTANCE_KEY_DIR, useValue: options.instanceKeyDir },
        { provide: RECEIPTS_ADMIN_ROLE, useValue: options.adminRole },
        {
          provide: SOURCE_DELETIONS,
          useFactory: (...adapters: SourceDeletion[]) => adapters,
          inject: options.sourceDeletions?.adapters ?? [],
        },
        {
          provide: DERIVED_CASCADES,
          useFactory: (...adapters: DerivedCascade[]) => adapters,
          inject: options.derivedCascades?.adapters ?? [],
        },
        { provide: INGESTION_GUARD, useClass: options.ingestionGuard },
        options.eligibilityHook
          ? { provide: MEMORY_ELIGIBILITY_HOOK, useClass: options.eligibilityHook }
          : { provide: MEMORY_ELIGIBILITY_HOOK, useValue: null },
        // The saga's and the sweep's collaborators, resolved BY TOKEN into one
        // named options bag each (V2.0 item 3.6 part 4): identity, never
        // position. The port tokens above remain the binding surface; these
        // factories are where they meet the consuming service.
        {
          provide: DELETION_SAGA_OPTIONS,
          useFactory: (
            adapters: SourceDeletion[],
            vectors: MemoryVectorStore,
            derivedCascades: DerivedCascade[],
            ingestionGuard: IngestionGuard,
          ): DeletionSagaOptions => ({ adapters, vectors, derivedCascades, ingestionGuard }),
          inject: [SOURCE_DELETIONS, MemoryVectorStore, DERIVED_CASCADES, INGESTION_GUARD],
        },
        {
          provide: SWEEP_OPTIONS,
          useFactory: (sourceAdapters: SourceDeletion[]): SweepOptions => ({ sourceAdapters }),
          inject: [SOURCE_DELETIONS],
        },
        MemoryStore,
        TimelineService,
        MemoryReconciliation,
        DeletionSaga,
        DeletionExecutor,
        IntegritySweep,
        MemoryFileStore,
        EmbeddingRebuildService,
        // Owner erasure (issue #632). Provided in BOTH roots: the app plans
        // and enqueues, the worker runs the pass. It holds no state and reads
        // only through the saga and the ports it already binds.
        OwnerErasureService,
        // The unscoped machine-read surface exists ONLY where a root asked for
        // it (V2.0 item 3.7). In the app process this provider is absent, so an
        // ungated corpus read is not something a request-path service can
        // inject: it would fail to resolve at boot rather than run.
        ...(options.systemReads ? [MemorySystemStore] : []),
      ],
      exports: [
        MemoryStore,
        TimelineService,
        MemoryReconciliation,
        DeletionSaga,
        DeletionExecutor,
        IntegritySweep,
        MemoryObjectStore,
        MemoryFileStore,
        EmbeddingRebuildService,
        OwnerErasureService,
        ...(options.systemReads ? [MemorySystemStore] : []),
      ],
    };
  }
}
