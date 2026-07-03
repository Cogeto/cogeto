import { describe, expect, it } from 'vitest';
import { MEMORY_STATUSES } from '@cogeto/shared';
import type { MemoryStatus } from '@cogeto/shared';
import { checkTransition } from './transition';
import type { ActorKind, MemoryActor } from './transition';

const ACTORS: MemoryActor[] = [
  { kind: 'user', userId: 'user-a' },
  { kind: 'reconciliation' },
  { kind: 'consolidation' },
  { kind: 'verification' },
  { kind: 'deletion_saga' },
];

/**
 * The full expected matrix, stated independently of the implementation:
 * which actor kinds may SET each target status (Addendum §A.1 rule 4,
 * glossary, S1-B prompt). `replaced` is reachable only via supersession and
 * is terminal; same-status transitions are no-ops and rejected.
 */
const EXPECTED_OWNERS: Record<MemoryStatus, ActorKind[]> = {
  active: ['user'],
  user_approved: ['user'],
  outdated: ['consolidation', 'user'],
  contradicted: ['reconciliation'],
  uncertain: ['verification'],
  replaced: [],
};

describe('memory transition matrix (unit)', () => {
  it('covers the full from x to x actor matrix', () => {
    let allowedCount = 0;
    for (const from of MEMORY_STATUSES) {
      for (const to of MEMORY_STATUSES) {
        for (const actor of ACTORS) {
          const expected =
            from !== 'replaced' &&
            from !== to &&
            to !== 'replaced' &&
            // S3-B: approval is the review verdict — only uncertain approves.
            !(to === 'user_approved' && from !== 'uncertain')
              ? EXPECTED_OWNERS[to].includes(actor.kind)
              : false;
          const result = checkTransition(from, to, actor);
          expect(
            result.allowed,
            `${from} -> ${to} as ${actor.kind} should be ${expected ? 'allowed' : 'rejected'}`,
          ).toBe(expected);
          if (expected) allowedCount += 1;
        }
      }
    }
    // 21 legal transitions exist; a change to this number is a domain decision
    // (was 24 before S3-B narrowed user_approved to the uncertain→approved path).
    expect(allowedCount).toBe(21);
  });

  it('explains rejections', () => {
    const asUser = checkTransition('active', 'contradicted', { kind: 'user', userId: 'u' });
    expect(asUser).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('reconciliation'),
    });

    const fromReplaced = checkTransition('replaced', 'active', { kind: 'user', userId: 'u' });
    expect(fromReplaced).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('terminal'),
    });

    const toReplaced = checkTransition('active', 'replaced', { kind: 'reconciliation' });
    expect(toReplaced).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('supersession'),
    });
  });
});
