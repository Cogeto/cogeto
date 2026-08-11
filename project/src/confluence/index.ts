/** Public interface of the confluence connector (spec §15 rule 1). */
export { ConfluenceModule, ConfluencePageCascadeModule } from './confluence.module';
export { ConfluencePageCascade } from './page-cascade';
export { ConfluencePageStore } from './persistence/page-store';
export type { ConfluenceProvenance } from './persistence/page-store';
export type { ConfluencePageRow } from './persistence/tables';
export { ConfluenceEstimateService } from './estimate';
export { CONFLUENCE_ESTIMATE_JOB_TYPE } from './jobs';
export { confluenceConnector, CONFLUENCE_KIND } from './descriptor';
export { convertStorageFormat } from './storage-format';
