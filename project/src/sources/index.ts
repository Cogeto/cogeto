/**
 * sources — the Sources surface's read context (V2.2 item 5.2): level one
 * (the catalog) and level two (the inspection). Composition only; no tables.
 */
export { SourcesModule } from './sources.module';
export { SourceCatalogService, UNLISTED_SOURCE_TYPES } from './source-catalog.service';
export type { CatalogQuery } from './source-catalog.service';
