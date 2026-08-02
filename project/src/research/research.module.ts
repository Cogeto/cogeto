import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { RESEARCH_OPTIONS } from './research-options';
import type { ResearchOptions } from './research-options';
import { ResearchController } from './research.controller';
import { ResearchService } from './research.service';
import { RESEARCH_CONCLUDE_WIRING, ResearchConclusionService } from './research-conclude';
import type { ResearchConcludeWiring } from './research-conclude';
import { WebDiscoveryService } from './web-discovery.service';
import { WebFetchService } from './web-fetch';
import { WebSourceReader } from './web.source-reader';
import { WebSourceDeletion } from './web.source-deletion';

/**
 * research — explicitly invoked web research behind the show-edit-approve
 * gate (V2.0 item 3.6 part 4, split out of the connectors context): SearXNG
 * discovery, the SSRF-guarded fetcher, retained pages as 'web' sources, and
 * the server-side conclusion. The app-only chat seam and synthesis live in
 * ResearchChatModule. NOT global: the roots thread the reader and deletion
 * adapters through ingestion's and memory's registration options.
 *
 * `skillAdvance` is the one cross-family seam pointing the OTHER way: the
 * settle-watcher enqueues the skills family's advance job when a settled run
 * belongs to a skill. The job type is owned and exported by skills; the
 * composition root passes the constant here, so no module cycle exists and
 * the one-declaration job-type rule still holds.
 */
@Module({})
export class ResearchModule {
  static register(options: {
    research: ResearchOptions;
    skillAdvance?: ResearchConcludeWiring;
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: ResearchModule,
      // The memory instance (B13): retained page objects and gated reads.
      imports: [...(options.imports ?? [])],
      controllers: [ResearchController],
      providers: [
        ResearchService,
        ResearchConclusionService,
        WebDiscoveryService,
        WebFetchService,
        WebSourceReader,
        WebSourceDeletion,
        { provide: RESEARCH_OPTIONS, useValue: options.research },
        { provide: RESEARCH_CONCLUDE_WIRING, useValue: options.skillAdvance ?? {} },
      ],
      exports: [
        ResearchService,
        ResearchConclusionService,
        WebSourceReader,
        WebSourceDeletion,
        RESEARCH_OPTIONS,
      ],
    };
  }
}
