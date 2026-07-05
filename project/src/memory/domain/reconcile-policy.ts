import type { MemoryStatus } from '@cogeto/shared';

/**
 * The pure policy half of reconciliation (decision 0010 rulings 3–5, 7):
 * survivor selection for merges, the confirm-resolution loser rule, and the
 * supersession direction guard. Pure functions so the calibration-sensitive
 * rules are unit-tested without containers — the acting half
 * (memory/reconciliation.ts) only executes what these decide.
 *
 * Calibration stance (binding): a wrong merge destroys a distinct fact; both
 * a wrong merge and a wrong contradiction are worse than doing nothing.
 */

export interface PolicyParty {
  id: string;
  status: MemoryStatus;
  createdAt: Date;
  validFrom: Date | null;
  validUntil: Date | null;
}

/** Confidence rank for survivor guard 2 (0010 ruling 4). */
const CONFIDENCE: Partial<Record<MemoryStatus, number>> = {
  user_approved: 2,
  active: 1,
  uncertain: 0,
};

export type MergeDecision =
  | { action: 'merge'; survivor: PolicyParty; loser: PolicyParty }
  | { action: 'none'; reason: string };

/**
 * Survivor selection on a `same_fact` verdict (0010 ruling 4): the newer
 * memory (created_at) survives, EXCEPT the older survives when it is
 * user_approved (user judgment outranks recency) or when the newer ranks
 * strictly below it on user_approved > active > uncertain (a verified fact
 * never yields to an unverified duplicate). Both user_approved → no merge
 * (0010 ruling 5: only the user resolves against their own confirmations).
 */
export function chooseSurvivor(a: PolicyParty, b: PolicyParty): MergeDecision {
  if (a.status === 'user_approved' && b.status === 'user_approved') {
    return { action: 'none', reason: 'both memories are user_approved' };
  }
  const [older, newer] = a.createdAt.getTime() <= b.createdAt.getTime() ? [a, b] : [b, a];
  if (older.status === 'user_approved') {
    return { action: 'merge', survivor: older, loser: newer };
  }
  if ((CONFIDENCE[newer.status] ?? 0) < (CONFIDENCE[older.status] ?? 0)) {
    return { action: 'merge', survivor: older, loser: newer };
  }
  return { action: 'merge', survivor: newer, loser: older };
}

/** Event time for ordering judgments: when the fact holds, else when captured. */
export function eventTime(party: PolicyParty): Date {
  return party.validFrom ?? party.createdAt;
}

/**
 * Confirm-resolution loser rule (0010 ruling 3): `outdated` when the loser was
 * time-superseded — its own interval had closed before the confirmed fact
 * began — else `replaced` with superseded_by pointing at the confirmed winner.
 */
export function confirmLoserOutcome(
  confirmed: PolicyParty,
  loser: PolicyParty,
): 'outdated' | 'replaced' {
  const confirmedFrom = eventTime(confirmed);
  if (loser.validUntil && loser.validUntil.getTime() <= confirmedFrom.getTime()) {
    return 'outdated';
  }
  return 'replaced';
}

/**
 * Supersession direction guard (0010 ruling 7): the model's winner must also
 * be the temporally later memory, and neither party may be user_approved —
 * anything else routes to contradiction so the user decides. Never silent
 * supersession on doubt.
 */
export function supersessionUnambiguous(winner: PolicyParty, loser: PolicyParty): boolean {
  if (winner.status === 'user_approved' || loser.status === 'user_approved') return false;
  return eventTime(winner).getTime() > eventTime(loser).getTime();
}
