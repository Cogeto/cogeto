import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalService } from './approval.service';
import { ApprovalExecutor } from './approval.executor';
import { ActionRegistry } from './action-registry';
import { ReplyDraftCascade } from './reply-draft-cascade';

/**
 * agents — the server-side approval state machine (the specification)
 * draft → pending_approval → approved → executed (+ rejected, expired).
 * The confirm endpoint (app) only transitions state; execution happens ONLY in
 * the worker via ApprovalExecutor. Effects reach the memory aggregate through
 * its public interface (MemoryStore, resolved from the global memory module) —
 * agents never touches another module's tables (spec §15). Registered in both
 * roots: the app serves the controller, the worker resolves the executor +
 * service for its job/cron handlers.
 */
@Module({})
export class AgentsModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: AgentsModule,
      // The memory module instance (B13 closed): actions reach the aggregate
      // through MemoryStore, resolved from an explicit import, never globality.
      imports: [...(options.imports ?? [])],
      controllers: [ApprovalsController],
      providers: [ActionRegistry, ApprovalService, ApprovalExecutor],
      exports: [ApprovalService, ApprovalExecutor],
    };
  }
}

/**
 * The reply-draft deletion cascade, bound into the memory saga's
 * derivedCascades. Kept in its OWN module — it has no dependency on the approval
 * state machine or the memory store (it only redacts the `approval` table by
 * source id) — so the memory module can import it without a cycle.
 */
@Module({
  providers: [ReplyDraftCascade],
  exports: [ReplyDraftCascade],
})
export class ReplyDraftCascadeModule {}
