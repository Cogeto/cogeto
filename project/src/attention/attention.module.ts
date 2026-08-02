import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { UserContextModule } from '../infrastructure/index';
import { AttentionController, DashboardController } from './attention.controller';
import { AttentionService } from './attention.service';

/**
 * attention — the "what needs my attention" feed and the dashboard statistics.
 *
 * App-only: both routes are fast-path reads and the worker serves no HTTP.
 *
 * Dynamic since B13 closed: `imports` receives the memory, retrieval and
 * agents module instances from the composition root — `MemoryStore`,
 * `MemoryReconciliation`, `RetrievalService` and `ApprovalService` all resolve
 * from explicit imports, never globality. Ingestion's dreaming reads are free
 * functions over the injected handle, not providers, so they need no module
 * edge at all.
 *
 * Nothing imports attention, so the graph stays acyclic.
 */
@Module({})
export class AttentionModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: AttentionModule,
      imports: [UserContextModule, ...(options.imports ?? [])],
      controllers: [AttentionController, DashboardController],
      providers: [AttentionService],
      exports: [AttentionService],
    };
  }
}
