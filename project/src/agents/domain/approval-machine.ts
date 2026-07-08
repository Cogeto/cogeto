import type { ApprovalStatus } from '@cogeto/shared';

/**
 * The approval aggregate's single transition function (Addendum §A.8, §A.1
 * rule 4). Legal edges — everything else is refused with a typed reason:
 *
 *   draft            → pending_approval        (submit for a decision)
 *   pending_approval → approved | rejected | expired
 *   approved         → executed                (worker only)
 *   rejected | expired | executed              — terminal
 *
 * Who may drive an edge is enforced by the caller (confirm endpoint = user;
 * execution = worker; expiry = the scheduled pass); this function owns only
 * which edges exist, so an executed record can never be re-approved and a
 * rejected/expired one can never execute.
 */
const EDGES: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'rejected', 'expired'],
  approved: ['executed'],
  rejected: [],
  expired: [],
  executed: [],
};

export type ApprovalTransitionCheck = { allowed: true } | { allowed: false; reason: string };

export function checkApprovalTransition(
  from: ApprovalStatus,
  to: ApprovalStatus,
): ApprovalTransitionCheck {
  if (EDGES[from].includes(to)) return { allowed: true };
  return {
    allowed: false,
    reason:
      EDGES[from].length === 0
        ? `${from} is terminal — no further transitions`
        : `illegal approval transition ${from} → ${to} (from ${from}, only ${EDGES[from].join(', ')})`,
  };
}

/** Job the confirm endpoint enqueues on approve — executed only in the worker. */
export const APPROVAL_EXECUTE_JOB_TYPE = 'approval.execute';
/** Idempotency source_type for the execution guard key: (approval, <id>). */
export const APPROVAL_JOB_SOURCE_TYPE = 'approval';
/** The scheduled expiry pass (cron task name — no dots, crontab parser rejects them). */
export const APPROVAL_EXPIRY_JOB_TYPE = 'approval_expiry';
/** Every 5 minutes: mark pending approvals past their expires_at as expired. */
export const APPROVAL_EXPIRY_CRONTAB = `*/5 * * * * ${APPROVAL_EXPIRY_JOB_TYPE}`;
