import { Module } from '@nestjs/common';
import { WebSourceReader } from './web.source-reader';
import { WebSourceDeletion } from './web.source-deletion';

/**
 * The research family's source PORTS as a slim standalone module (V2.0 item
 * 3.6 part 4, the ChatSourceModule shape): the pipeline reader and the
 * deletion adapter, whose only dependency is the global DRIZZLE handle. The
 * memory and ingestion modules import THIS through their registration
 * options, which is what keeps memory ↔ research free of a module cycle now
 * that nothing is global (B13).
 */
@Module({
  providers: [WebSourceReader, WebSourceDeletion],
  exports: [WebSourceReader, WebSourceDeletion],
})
export class ResearchSourcePortsModule {}
