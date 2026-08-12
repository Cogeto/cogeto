import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { UserContextModule } from '../infrastructure/index';
import { DreamingController } from './dreaming.controller';
import { DreamingService } from './dreaming.service';
import { AnchorStage } from './pipeline/anchor.stage';
import { ExtractionGateController } from './extraction-gate.controller';
import { SourceContextController } from './source-context.controller';
import { SourceRevisionsController } from './source-revisions.controller';
import { SourceRevisionStore } from './persistence/source-revision.store';
import { EmbedStoreStage } from './pipeline/embed-store.stage';
import { ExtractStage } from './pipeline/extract.stage';
import { IngestionPipeline } from './pipeline/pipeline.service';
import { ReconciliationService } from './pipeline/reconcile.stage';
import { SOURCE_READERS } from './pipeline/source-reader';
import type { SourceReader } from './pipeline/source-reader';
import { VerifyStage } from './pipeline/verify.stage';
import { CheckedPairStore } from './persistence/checked-pair.store';
import { EntityAliasStore } from './persistence/entity-alias.store';
import { EntityAliasesController } from './entity-aliases.controller';
import { ExtractionGateStore } from './persistence/extraction-gate.store';
import { PROJECT_POLICY } from './project-policy.port';
import type { ProjectPolicyPort } from './project-policy.port';
import { IngestionProgressStore } from './persistence/ingestion-progress';
import { ReconcileRepair, ReconcileRepairEligibilityHook } from './reconcile-repair';
import { RECONCILE_MODEL_CONFIG } from './pipeline/reconcile.stage';
import { SourceContextStore } from './persistence/source-context.store';
import { SuppressedFactLog } from './persistence/suppressed-fact-log';
import { SuppressedFactCascade } from './suppressed-fact-cascade';
import { SuppressedFactsController } from './suppressed-facts.controller';
import { VerificationController } from './verification.controller';

export interface IngestionModuleOptions {
  /** Modules whose exports provide the reader classes (e.g. ConnectorsModule). */
  imports?: ModuleMetadata['imports'];
  /** Source-reader implementations, one per connector source type. */
  readers: Type<SourceReader>[];
  /** Implementation of ingestion's per-project extraction-policy port (V2.5
   * item 8.3), bound by the composition root. */
  projectPolicy?: Type<ProjectPolicyPort>;
  /**
   * The generation binding recorded beside every ledger verdict (V2.3 item
   * 6.1): `<provider>/<model>` for the pipeline tier. A model change makes
   * stored verdicts disagree with this string, which re-opens judged pairs.
   *
   * A GETTER is accepted as well as a string (V2.4 item 7.1): the pipeline
   * binding can now change while the worker runs, and a label captured at boot
   * would let the ledger skip re-judging pairs under a model that changed.
   */
  reconcileModelConfig?: string | (() => string);
}

/**
 * ingestion — the ingest → chunk → extract → verify → embed + store → reconcile
 * pipeline (scope §4.9, spec §2). Pipeline work is worker-only. Source
 * readers are bound by the composition root: connectors depend on ingestion's
 * port, never the reverse, so the module graph stays acyclic (spec §15).
 */
@Module({})
export class IngestionModule {
  static register(options: IngestionModuleOptions): DynamicModule {
    return {
      module: IngestionModule,
      // MemoryStore and ModelGateway resolve from the global memory/seam
      // modules registered by the composition root.
      imports: [...(options.imports ?? [])],
      providers: [
        ExtractStage,
        VerifyStage,
        AnchorStage,
        SourceContextStore,
        SuppressedFactLog,
        SuppressedFactCascade,
        ExtractionGateStore,
        IngestionProgressStore,
        EmbedStoreStage,
        // The reconcile engine's V2.3 collaborators: the judged-pair ledger,
        // the alias set, the revision link (the auto-resolution evidence),
        // and the repair pass with its eligibility-hook implementation.
        CheckedPairStore,
        EntityAliasStore,
        SourceRevisionStore,
        ReconcileRepair,
        ReconcileRepairEligibilityHook,
        {
          provide: RECONCILE_MODEL_CONFIG,
          useValue: options.reconcileModelConfig ?? 'unconfigured',
        },
        ReconciliationService,
        IngestionPipeline,
        DreamingService,
        {
          provide: SOURCE_READERS,
          useFactory: (...readers: SourceReader[]) => readers,
          inject: options.readers,
        },
        // The per-project extraction policy (V2.5 item 8.3 issue C4): the
        // port is ingestion's, the implementation is projects', the root
        // supplies the class. Absent = no project has an opinion, which is
        // the pre-feature path.
        ...(options.projectPolicy
          ? [{ provide: PROJECT_POLICY, useExisting: options.projectPolicy }]
          : []),
      ],
      // SuppressedFactCascade is exported so the composition root can bind it
      // into memory's DERIVED_CASCADES: the port is memory's, the table is
      // ingestion's, and neither module reaches into the other (spec §15).
      // ExtractionGateStore rides along for the worker's refusal-retention job.
      exports: [
        IngestionPipeline,
        DreamingService,
        SuppressedFactLog,
        SuppressedFactCascade,
        ExtractionGateStore,
        SourceContextStore,
        ReconcileRepair,
      ],
    };
  }

  /**
   * The app-process slice: only the read endpoints — the
   * verification verdict panel, the dreaming digest, and the suppressed-fact
   * log's query surface. No pipeline, no stages, no readers. Ingestion keeps
   * sole ownership of its tables.
   */
  static forQueries(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: IngestionModule,
      // UserContextModule: the dreaming digest is written in the reader's
      // preferred language. Explicit since it stopped being global; the memory
      // module instance arrives the same way since B13 closed.
      imports: [UserContextModule, ...(options.imports ?? [])],
      controllers: [
        VerificationController,
        DreamingController,
        SuppressedFactsController,
        // The extraction gate's settings surface (V2.1 item 4.3): app-side
        // configuration reads and writes; enforcement stays worker-side.
        ExtractionGateController,
        // The anchoring context's read/edit surface (V2.1 item 4.2).
        SourceContextController,
        // The revision link's owner surface (V2.2 item 5.3).
        SourceRevisionsController,
        // The entity-alias settings surface (V2.3 item 6.1).
        EntityAliasesController,
      ],
      providers: [
        SuppressedFactLog,
        ExtractionGateStore,
        SourceContextStore,
        SourceRevisionStore,
        EntityAliasStore,
      ],
    };
  }
}

/**
 * The suppressed-fact deletion cascade, bound into the memory saga's
 * `derivedCascades`. Kept in its OWN module, like the reply-draft cascade before
 * it: it depends on nothing but the log's own table access, so the memory module
 * can import it without a cycle back through the pipeline.
 */
@Module({
  providers: [SuppressedFactLog, SuppressedFactCascade],
  exports: [SuppressedFactLog, SuppressedFactCascade],
})
export class SuppressedFactCascadeModule {}
