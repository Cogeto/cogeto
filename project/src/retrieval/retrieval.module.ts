import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { DEFAULT_INSTANCE_TIMEZONE, DRIZZLE, INSTANCE_TIMEZONE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { RETRIEVAL_SERVICE_OPTIONS, RetrievalService } from './retrieval.service';
import type { RetrievalServiceOptions } from './retrieval.service';

/**
 * retrieval — hybrid, fused, filtered search (spec §3.4). Composes the memory
 * module's Principal-gated search primitives, including the open-loops read
 * behind the day-one question. The chat area is its own `chat/` context since
 * V2.0 item 3.6 part 4; everything here is fast path.
 *
 * Dynamic since B13 closed: `imports` receives the ONE memory module instance
 * from the composition root — no module is resolved through globality.
 */
@Module({})
export class RetrievalModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: RetrievalModule,
      imports: [...(options.imports ?? [])],
      providers: [
        RetrievalService,
        // The optional collaborators, resolved BY TOKEN into one named options
        // object (V2.0 item 3.6 part 4): identity, never position.
        {
          provide: RETRIEVAL_SERVICE_OPTIONS,
          useFactory: (db?: Db, timeZone?: string): RetrievalServiceOptions => ({
            db,
            timeZone: timeZone ?? DEFAULT_INSTANCE_TIMEZONE,
          }),
          inject: [
            { token: DRIZZLE, optional: true },
            { token: INSTANCE_TIMEZONE, optional: true },
          ],
        },
      ],
      exports: [RetrievalService],
    };
  }
}
