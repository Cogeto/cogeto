import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalService } from './approval.service';
import { ApprovalExecutor } from './approval.executor';
import { ActionRegistry } from './action-registry';

/**
 * agents — the server-side approval state machine (Addendum §A.8):
 * draft → pending_approval → approved → executed (+ rejected, expired).
 * The confirm endpoint (app) only transitions state; execution happens ONLY in
 * the worker via ApprovalExecutor. Effects reach the memory aggregate through
 * its public interface (MemoryStore, resolved from the global memory module) —
 * agents never touches another module's tables (§A.1). Registered in both
 * roots: the app serves the controller, the worker resolves the executor +
 * service for its job/cron handlers.
 */
@Module({
  controllers: [ApprovalsController],
  providers: [ActionRegistry, ApprovalService, ApprovalExecutor],
  exports: [ApprovalService, ApprovalExecutor],
})
export class AgentsModule {}
