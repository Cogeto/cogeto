import { describe, expect, it } from 'vitest';
import type { MemoryStatus } from '@cogeto/shared';
import { chooseSurvivor, confirmLoserOutcome, supersessionUnambiguous } from './reconcile-policy';
import type { PolicyParty } from './reconcile-policy';

const party = (
  id: string,
  status: MemoryStatus,
  createdAt: string,
  opts: { validFrom?: string; validUntil?: string } = {},
): PolicyParty => ({
  id,
  status,
  createdAt: new Date(createdAt),
  validFrom: opts.validFrom ? new Date(opts.validFrom) : null,
  validUntil: opts.validUntil ? new Date(opts.validUntil) : null,
});

describe('reconcile policy (unit — decision 0010 rulings 3, 4, 5, 7)', () => {
  it('survivor: the newer memory wins by default', () => {
    const older = party('old', 'active', '2026-07-01');
    const newer = party('new', 'active', '2026-07-03');
    expect(chooseSurvivor(older, newer)).toMatchObject({
      action: 'merge',
      survivor: { id: 'new' },
      loser: { id: 'old' },
    });
  });

  it('survivor: an older user_approved outranks recency', () => {
    const older = party('old', 'user_approved', '2026-07-01');
    const newer = party('new', 'active', '2026-07-03');
    expect(chooseSurvivor(older, newer)).toMatchObject({
      action: 'merge',
      survivor: { id: 'old' },
      loser: { id: 'new' },
    });
  });

  it('survivor: a verified fact never yields to an uncertain duplicate', () => {
    const older = party('old', 'active', '2026-07-01');
    const newer = party('new', 'uncertain', '2026-07-03');
    expect(chooseSurvivor(older, newer)).toMatchObject({
      action: 'merge',
      survivor: { id: 'old' },
      loser: { id: 'new' },
    });
  });

  it('survivor: a newer user_approved (edit successor) beats an older active', () => {
    const older = party('old', 'active', '2026-07-01');
    const newer = party('new', 'user_approved', '2026-07-03');
    expect(chooseSurvivor(older, newer)).toMatchObject({
      action: 'merge',
      survivor: { id: 'new' },
    });
  });

  it('survivor: two user_approved memories never merge (only the user resolves)', () => {
    const a = party('a', 'user_approved', '2026-07-01');
    const b = party('b', 'user_approved', '2026-07-03');
    expect(chooseSurvivor(a, b).action).toBe('none');
  });

  it('confirm loser: outdated only when its own interval closed before the winner began', () => {
    const winner = party('w', 'contradicted', '2026-07-03', { validFrom: '2026-06-01' });
    const timeSuperseded = party('l1', 'contradicted', '2026-07-01', {
      validFrom: '2026-01-01',
      validUntil: '2026-02-01',
    });
    const openEnded = party('l2', 'contradicted', '2026-07-01');
    expect(confirmLoserOutcome(winner, timeSuperseded)).toBe('outdated');
    expect(confirmLoserOutcome(winner, openEnded)).toBe('replaced');
  });

  it('direction guard: winner must be temporally later and neither user_approved', () => {
    const earlier = party('e', 'active', '2026-07-01', { validFrom: '2026-05-01' });
    const later = party('l', 'active', '2026-07-03', { validFrom: '2026-06-01' });
    expect(supersessionUnambiguous(later, earlier)).toBe(true);
    expect(supersessionUnambiguous(earlier, later)).toBe(false); // wrong order
    expect(supersessionUnambiguous(later, { ...earlier, status: 'user_approved' as const })).toBe(
      false,
    );
    expect(supersessionUnambiguous({ ...later, status: 'user_approved' as const }, earlier)).toBe(
      false,
    );
    // Equal event times are ambiguous by definition.
    expect(supersessionUnambiguous(later, { ...earlier, validFrom: later.validFrom })).toBe(false);
  });
});
