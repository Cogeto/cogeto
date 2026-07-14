import { describe, expect, it } from 'vitest';
import type { MemoryListItem } from '@cogeto/shared';
import { computeTimelineDiff, laterFateOf } from '@cogeto/shared';

/**
 * The between-two-points diff and the later-fate label are pure (decision 0012
 * ruling 4 / ruling 6): no model, no database. They operate on the gated facts
 * each `pointInTime` snapshot already returned; here we exercise the set
 * arithmetic and the past-framing twin directly.
 */

const item = (id: string, over: Partial<MemoryListItem> = {}): MemoryListItem => ({
  id,
  content: `fact ${id}`,
  status: 'active',
  scope: 'private',
  ownerId: 'owner',
  ownerName: null,
  sensitive: false,
  entities: ['Atlas'],
  kind: null,
  sourceType: 'user_note',
  sourceId: `src-${id}`,
  supersededBy: null,
  validFrom: null,
  validUntil: null,
  temporalUnresolved: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('computeTimelineDiff (diff_between_points)', () => {
  it('classifies added / changed / removed / unchanged between two snapshots', () => {
    const stable = item('stable'); // held at both points
    const droppedNoSuccessor = item('dropped', { status: 'outdated' }); // gone, no successor
    // X held at `from`, superseded by Y which holds at `to` — a change X→Y.
    const before = item('x', { status: 'replaced', supersededBy: 'y' });
    const after = item('y');
    const learned = item('z'); // new at `to`

    const factsAtFrom = [stable, droppedNoSuccessor, before];
    const factsAtTo = [stable, after, learned];

    const diff = computeTimelineDiff(factsAtFrom, factsAtTo);

    expect(diff.unchanged.map((m) => m.id)).toEqual(['stable']);
    expect(diff.removed.map((m) => m.id)).toEqual(['dropped']);
    expect(diff.changed).toEqual([{ before, after }]);
    // The successor of a change is NOT double-counted as an addition.
    expect(diff.added.map((m) => m.id)).toEqual(['z']);
  });

  it('reads an unseen intermediate version as removed + added, not a phantom change', () => {
    // X → Y → Z, but only X (at `from`) and Z (at `to`) are in the snapshots;
    // Y held at neither instant, so it is not in either set.
    const x = item('x', { status: 'replaced', supersededBy: 'y' });
    const z = item('z');
    const diff = computeTimelineDiff([x], [z]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed.map((m) => m.id)).toEqual(['x']);
    expect(diff.added.map((m) => m.id)).toEqual(['z']);
  });

  it('an empty-to-empty window yields four empty sets', () => {
    const diff = computeTimelineDiff([], []);
    expect(diff).toEqual({ added: [], changed: [], removed: [], unchanged: [] });
  });
});

describe('laterFateOf (past-framing twin, decision 0012 ruling 6)', () => {
  const now = Date.parse('2026-07-01T00:00:00.000Z');

  it('a still-active, still-open fact is current', () => {
    expect(laterFateOf(item('a'), now)).toBe('still_current');
  });

  it('a superseded fact reads as replaced', () => {
    expect(laterFateOf(item('a', { status: 'replaced', supersededBy: 'b' }), now)).toBe('replaced');
  });

  it('an outdated fact reads as outdated', () => {
    expect(laterFateOf(item('a', { status: 'outdated' }), now)).toBe('outdated');
  });

  it('a closed interval before now reads as expired', () => {
    expect(laterFateOf(item('a', { validUntil: '2026-05-01T00:00:00.000Z' }), now)).toBe('expired');
  });

  it('a closed interval still in the future is not yet expired', () => {
    expect(laterFateOf(item('a', { validUntil: '2026-09-01T00:00:00.000Z' }), now)).toBe(
      'still_current',
    );
  });
});
