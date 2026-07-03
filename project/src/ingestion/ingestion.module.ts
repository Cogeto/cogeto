import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { MemoryModule } from '../memory/index';
import { ExtractStage } from './pipeline/extract.stage';
import { IngestionPipeline } from './pipeline/pipeline.service';
import { SOURCE_READERS } from './pipeline/source-reader';
import type { SourceReader } from './pipeline/source-reader';
import { VerifyStage } from './pipeline/verify.stage';

export interface IngestionModuleOptions {
  /** Modules whose exports provide the reader classes (e.g. ConnectorsModule). */
  imports?: ModuleMetadata['imports'];
  /** Source-reader implementations, one per connector source type. */
  readers: Type<SourceReader>[];
}

/**
 * ingestion — the ingest → chunk → extract → verify → embed + store → reconcile
 * pipeline (scope §4.9, Addendum §B.3). Worker-only. Source readers are bound
 * by the composition root: connectors depend on ingestion's port, never the
 * reverse, so the module graph stays acyclic (§A.1).
 */
@Module({})
export class IngestionModule {
  static register(options: IngestionModuleOptions): DynamicModule {
    return {
      module: IngestionModule,
      imports: [MemoryModule, ...(options.imports ?? [])],
      providers: [
        ExtractStage,
        VerifyStage,
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
}
