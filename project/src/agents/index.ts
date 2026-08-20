/** Public interface of the agents bounded context (spec §15 rule 1). */
export { AgentsModule, ReplyDraftCascadeModule } from './agents.module';
export { ReplyDraftCascade } from './reply-draft-cascade';
export { AgentsSpaceCleanup, AgentsSpaceCleanupModule } from './agents-space-cleanup';
export { ApprovalService } from './approval.service';
export { ApprovalExecutor } from './approval.executor';
export { ActionRegistry } from './action-registry';
export {
  APPROVAL_EXECUTE_JOB_TYPE,
  APPROVAL_EXPIRY_JOB_TYPE,
  APPROVAL_EXPIRY_CRONTAB,
} from './domain/approval-machine';
