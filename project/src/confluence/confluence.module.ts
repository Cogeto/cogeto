import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { ConfluenceController } from './confluence.controller';
import { ConfluenceEstimateService } from './estimate';
import { ConfluencePageStore } from './persistence/page-store';
import { ConfluencePageCascade } from './page-cascade';

/**
 * confluence — the Confluence Cloud connector (V2.5 item 8.2), the first
 * real connector on the platform. Owns the `confluence_page` provenance
 * table and the `confluence.estimate` job; its descriptor
 * (`confluenceConnector()`) registers with `ConnectorsModule` in both
 * composition roots. Strictly read-only by construction: see
 * read-only.spec.ts and docs/features/confluence.md.
 */
@Module({})
export class ConfluenceModule {
  /** The app-side slice: the connect flow and the provenance reads. */
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: ConfluenceModule,
      imports: [...(options.imports ?? [])],
      controllers: [ConfluenceController],
      providers: [ConfluencePageStore],
      exports: [ConfluencePageStore],
    };
  }

  /** The worker-side slice: the estimate job's service. */
  static forWorker(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: ConfluenceModule,
      imports: [...(options.imports ?? [])],
      providers: [ConfluencePageStore, ConfluenceEstimateService],
      exports: [ConfluencePageStore, ConfluenceEstimateService],
    };
  }
}

/** The cascade adapter's slim module (the ConnectorItemCascade precedent):
 * table access only, importable by memory's cascade bindings. */
@Module({
  providers: [ConfluencePageStore, ConfluencePageCascade],
  exports: [ConfluencePageCascade],
})
export class ConfluencePageCascadeModule {}
