import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { EmbedStoreStage } from './pipeline/embed-store.stage';
import { ExtractStage } from './pipeline/extract.stage';
import { IngestionPipeline } from './pipeline/pipeline.service';
import { ReconciliationService } from './pipeline/reconcile.stage';
import { SOURCE_READERS } from './pipeline/source-reader';
import type { SourceReader } from './pipeline/source-reader';
import { VerifyStage } from './pipeline/verify.stage';
import { VerificationController } from './verification.controller';

export interface IngestionModuleOptions {
  /** Modules whose exports provide the reader classes (e.g. ConnectorsModule). */
  imports?: ModuleMetadata['imports'];
  /** Source-reader implementations, one per connector source type. */
  readers: Type<SourceReader>[];
}

/**
 * ingestion — the ingest → chunk → extract → verify → embed + store → reconcile
 * pipeline (scope §4.9, Addendum §B.3). Pipeline work is worker-only. Source
 * readers are bound by the composition root: connectors depend on ingestion's
 * port, never the reverse, so the module graph stays acyclic (§A.1).
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
        EmbedStoreStage,
        ReconciliationService,
        IngestionPipeline,
        {
          provide: SOURCE_READERS,
          useFactory: (...readers: SourceReader[]) => readers,
          inject: options.readers,
        },
      ],
      exports: [IngestionPipeline],
    };
  }

  /**
   * The app-process slice (S3-B): only the verification read endpoint — no
   * pipeline, no stages, no readers. Ingestion keeps sole ownership of its
   * table; the dashboard gets its verdict panel.
   */
  static forQueries(): DynamicModule {
    return {
      module: IngestionModule,
      controllers: [VerificationController],
    };
  }
}
