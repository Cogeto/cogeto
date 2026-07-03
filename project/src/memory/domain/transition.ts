import type { MemoryStatus } from '@cogeto/shared';

/**
 * The Memory aggregate's single transition function (§A.1 rule 4).
 *
 * Ownership of transitions (Addendum, glossary, S1-B prompt):
 * - `contradicted`  — only reconciliation.
 * - `user_approved` — only the user, and only FROM `uncertain`: it is the
 *   review verdict (S3-B), not a general blessing of any memory.
 * - `outdated`      — consolidation or the user.
 * - `uncertain`     — only the verification pass (§B.3 demotion).
 * - `active`        — only the user (re-affirming / correcting a memory).
 * - `replaced`      — never via transition: only supersession sets it, closing
 *   `valid_until` and pointing `superseded_by` at the successor (§B.2).
 * - `replaced` is terminal: history rows never transition again.
 * - Hard delete happens only in the deletion saga (§A.7) — not a transition.
 */
export type MemoryActor =
  | { kind: 'user'; userId: string }
  | { kind: 'reconciliation' }
  | { kind: 'consolidation' }
  | { kind: 'verification' }
  | { kind: 'deletion_saga' };

export type ActorKind = MemoryActor['kind'];

export type TransitionCheck = { allowed: true } | { allowed: false; reason: string };

const TRANSITION_OWNERS: Record<MemoryStatus, readonly ActorKind[]> = {
  contradicted: ['reconciliation'],
  user_approved: ['user'],
  outdated: ['consolidation', 'user'],
  uncertain: ['verification'],
  active: ['user'],
  replaced: [], // only supersede() — see MemoryStore.supersede
};

export function checkTransition(
  from: MemoryStatus,
  to: MemoryStatus,
  actor: MemoryActor,
): TransitionCheck {
  if (from === 'replaced') {
    return { allowed: false, reason: 'replaced is terminal: superseded history never transitions' };
  }
  if (from === to) {
    return { allowed: false, reason: `memory is already ${to}` };
  }
  if (to === 'replaced') {
    return { allowed: false, reason: 'replaced is set only by supersession, never by transition' };
  }
  if (to === 'user_approved' && from !== 'uncertain') {
    return {
      allowed: false,
      reason: `user_approved is the review verdict: only an uncertain memory can be approved (this one is ${from})`,
    };
  }
  const owners = TRANSITION_OWNERS[to];
  if (!owners.includes(actor.kind)) {
    return {
      allowed: false,
      reason: `only ${owners.join(' or ')} may set ${to} (actor: ${actor.kind})`,
    };
  }
  return { allowed: true };
}

export function actorLabel(actor: MemoryActor): string {
  return actor.kind === 'user' ? `user:${actor.userId}` : actor.kind;
}
