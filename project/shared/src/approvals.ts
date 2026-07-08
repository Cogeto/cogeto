/** Approval state-machine DTOs (Addendum §A.8; O1-B). */

export const APPROVAL_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'executed',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * One approval row for the Pending Approvals surface. `summary` and `preview`
 * are rendered server-side from the action-type registry so the client never
 * needs to know an action's payload shape.
 */
export interface ApprovalDto {
  id: string;
  actionType: string;
  status: ApprovalStatus;
  /** Human one-liner, e.g. "Mark 12 memories outdated". */
  summary: string;
  /** Payload preview lines rendered per the action-type registry. */
  preview: string[];
  requestedBy: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  executedAt: string | null;
  /** Present after execution: the effect's human-readable outcome. */
  result: string | null;
}

export interface CreateApprovalRequest {
  actionType: string;
  payload: unknown;
}

export type ApprovalDecision = 'approve' | 'reject';
export interface ConfirmApprovalRequest {
  decision: ApprovalDecision;
}

/** The one wired consequential action (O1-B §3): bulk memory status change. */
export const BULK_OUTDATE_ACTION = 'memory.bulk_outdate';
export interface BulkOutdatePayload {
  memoryIds: string[];
  reason?: string;
}
