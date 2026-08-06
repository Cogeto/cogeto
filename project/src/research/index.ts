/**
 * research — gated web research and retained pages (V2.0 item 3.6 part 4,
 * split out of connectors). Nothing is sent until the user approves a
 * proposed run; direct URL capture sends no query anywhere.
 */
export { ResearchModule } from './research.module';
export { ResearchService } from './research.service';
export {
  ResearchConclusionService,
  RESEARCH_CONCLUDE_JOB_TYPE,
  RESEARCH_CONCLUDE_WIRING,
} from './research-conclude';
export { ChatResearchResolver } from './chat-research-resolver';
export { RESEARCH_SYNTHESIS_OPTIONS, ResearchSynthesisService } from './research-synthesis.service';
export type { ResearchSynthesisOptions } from './research-synthesis.service';
export { ResearchChatModule } from './research-chat.module';
export { WebDiscoveryService } from './web-discovery.service';
export { WebFetchService } from './web-fetch';
export { WebSourceReader } from './web.source-reader';
export { WebSourceDeletion } from './web.source-deletion';
export { RESEARCH_OPTIONS } from './research-options';
export type { ResearchOptions } from './research-options';
export type { ResearchRunRow, WebPageRow } from './persistence/tables';
export { ResearchSourcePortsModule } from './research-source-ports.module';

// The source catalog's web listing (V2.2 item 5.2).
export { listWebSources, hydrateWebSources, countWebSources } from './source-listing';
