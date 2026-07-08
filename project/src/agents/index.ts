/** Public interface of the agents bounded context (§A.1 rule 1). */
export { AgentsModule } from './agents.module';
export { ApprovalService } from './approval.service';
export { ApprovalExecutor } from './approval.executor';
export { ActionRegistry } from './action-registry';
export type { ActionDefinition, ActionContext, ActionResult } from './action-types';
export {
  checkApprovalTransition,
  APPROVAL_EXECUTE_JOB_TYPE,
  APPROVAL_JOB_SOURCE_TYPE,
  APPROVAL_EXPIRY_JOB_TYPE,
  APPROVAL_EXPIRY_CRONTAB,
} from './domain/approval-machine';
export type { ApprovalTransitionCheck } from './domain/approval-machine';
