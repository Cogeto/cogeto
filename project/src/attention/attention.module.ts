import { Module } from '@nestjs/common';
import { UserContextModule } from '../infrastructure/index';
import { RetrievalModule } from '../retrieval/index';
import { AgentsModule } from '../agents/index';
import { AttentionController, DashboardController } from './attention.controller';
import { AttentionService } from './attention.service';

/**
 * attention — the "what needs my attention" feed and the dashboard statistics.
 *
 * App-only: both routes are fast-path reads and the worker serves no HTTP.
 *
 * The imports are the real ones: `RetrievalService` (the single open-loops
 * read), `ApprovalService` (pending decisions) and `UserContextService` (the
 * reader's preferred language). `MemoryStore` and `MemoryReconciliation` come
 * from the global `MemoryModule` (recorded exception B13) — listing it here
 * would be a no-op import that makes the graph look more explicit than it is.
 * Ingestion's dreaming reads are free functions over the injected handle, not
 * providers, so they need no module edge at all.
 *
 * Nothing imports attention, so the graph stays acyclic.
 */
@Module({
  imports: [RetrievalModule, AgentsModule, UserContextModule],
  controllers: [AttentionController, DashboardController],
  providers: [AttentionService],
  exports: [AttentionService],
})
export class AttentionModule {}
