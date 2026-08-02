import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { UserContextModule } from '../infrastructure/index';
import { DreamingController } from './dreaming.controller';
import { DreamingService } from './dreaming.service';
import { EmbedStoreStage } from './pipeline/embed-store.stage';
import { ExtractStage } from './pipeline/extract.stage';
import { IngestionPipeline } from './pipeline/pipeline.service';
import { ReconciliationService } from './pipeline/reconcile.stage';
import { SOURCE_READERS } from './pipeline/source-reader';
import type { SourceReader } from './pipeline/source-reader';
import { VerifyStage } from './pipeline/verify.stage';
import { SuppressedFactLog } from './persistence/suppressed-fact-log';
import { SuppressedFactCascade } from './suppressed-fact-cascade';
import { SuppressedFactsController } from './suppressed-facts.controller';
import { VerificationController } from './verification.controller';

export interface IngestionModuleOptions {
  /** Modules whose exports provide the reader classes (e.g. ConnectorsModule). */
  imports?: ModuleMetadata['imports'];
  /** Source-reader implementations, one per connector source type. */
  readers: Type<SourceReader>[];
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
        SuppressedFactLog,
        SuppressedFactCascade,
        EmbedStoreStage,
        ReconciliationService,
        IngestionPipeline,
        DreamingService,
        {
          provide: SOURCE_READERS,
          useFactory: (...readers: SourceReader[]) => readers,
          inject: options.readers,
        },
      ],
      // SuppressedFactCascade is exported so the composition root can bind it
      // into memory's DERIVED_CASCADES: the port is memory's, the table is
      // ingestion's, and neither module reaches into the other (spec §15).
      exports: [IngestionPipeline, DreamingService, SuppressedFactLog, SuppressedFactCascade],
    };
  }

  /**
   * The app-process slice: only the read endpoints — the
   * verification verdict panel, the dreaming digest, and the suppressed-fact
   * log's query surface. No pipeline, no stages, no readers. Ingestion keeps
   * sole ownership of its tables.
   */
  static forQueries(): DynamicModule {
    return {
      module: IngestionModule,
      // UserContextModule: the dreaming digest is written in the reader's
      // preferred language. Explicit since it stopped being global.
      imports: [UserContextModule],
      controllers: [VerificationController, DreamingController, SuppressedFactsController],
      providers: [SuppressedFactLog],
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
