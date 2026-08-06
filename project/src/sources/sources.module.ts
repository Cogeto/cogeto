import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { SuppressedFactLog, SourceContextStore } from '../ingestion/index';
import { SourceCatalogController } from './source-catalog.controller';
import { SourceCatalogService } from './source-catalog.service';

/**
 * sources — the Sources surface's read context (V2.2 item 5.2): the catalog
 * (one row per source, badges as the scan layer) and the per-source
 * inspection. A declared composition context in the `attention`/`operations`
 * shape: it owns NO tables and reads every module through its public
 * interface — memory's gated stores arrive through the threaded module
 * instance; the family listings, badge reads and verification joins are the
 * owners' exported functions over this context's DRIZZLE handle.
 *
 * `SuppressedFactLog` and `SourceContextStore` are ingestion's exported
 * classes provided here directly: they carry only their own table access over
 * the global DRIZZLE, the `ChatSourceModule` precedent for slim reuse.
 *
 * App-only: the worker serves no reads.
 */
@Module({})
export class SourcesModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: SourcesModule,
      imports: [...(options.imports ?? [])],
      controllers: [SourceCatalogController],
      providers: [SourceCatalogService, SuppressedFactLog, SourceContextStore],
    };
  }
}
