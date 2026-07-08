import { describe, expect, it } from 'vitest';
import type { ApprovalStatus } from '@cogeto/shared';
import { checkApprovalTransition } from './approval-machine';

describe('checkApprovalTransition (the approval aggregate edges)', () => {
  const legal: Array<[ApprovalStatus, ApprovalStatus]> = [
    ['draft', 'pending_approval'],
    ['pending_approval', 'approved'],
    ['pending_approval', 'rejected'],
    ['pending_approval', 'expired'],
    ['approved', 'executed'],
  ];
  const illegal: Array<[ApprovalStatus, ApprovalStatus]> = [
    ['approved', 'rejected'], // an approved action cannot be un-approved
    ['executed', 'approved'], // terminal: cannot re-approve an executed record
    ['rejected', 'approved'],
    ['expired', 'approved'],
    ['pending_approval', 'executed'], // must be approved first, in the worker
    ['draft', 'approved'], // must be submitted first
  ];

  it('permits exactly the legal edges', () => {
    for (const [from, to] of legal) {
      expect(checkApprovalTransition(from, to).allowed).toBe(true);
    }
  });

  it('refuses every other edge with a reason', () => {
    for (const [from, to] of illegal) {
      const check = checkApprovalTransition(from, to);
      expect(check.allowed).toBe(false);
      if (!check.allowed) expect(check.reason.length).toBeGreaterThan(0);
    }
  });

  it('treats rejected/expired/executed as terminal', () => {
    for (const terminal of ['rejected', 'expired', 'executed'] as const) {
      for (const to of ['approved', 'executed', 'pending_approval'] as const) {
        expect(checkApprovalTransition(terminal, to).allowed).toBe(false);
      }
    }
  });
});
