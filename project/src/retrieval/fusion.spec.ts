import { describe, expect, it } from 'vitest';
import type { MemoryStatus } from '@cogeto/shared';
import { fuseAndRank } from './fusion';
import type { RankedList } from './fusion';

/**
 * fusion_multipliers: the S3-A named test. Pure — seeded ranks in, deterministic
 * fused order out; the §A.5 status multipliers applied exactly.
 */

const statuses = (map: Record<string, MemoryStatus>) => (id: string) => map[id];

describe('reciprocal rank fusion + status multipliers (§A.5)', () => {
  it('fuses deterministically: same seeded ranks, same order, every time', () => {
    const lists: RankedList[] = [
      { signal: 'vector', ids: ['m1', 'm2', 'm3'] },
      { signal: 'fts', ids: ['m2', 'm1'] },
      { signal: 'entity', ids: ['m2'] },
    ];
    const statusOf = statuses({ m1: 'active', m2: 'active', m3: 'active' });

    const first = fuseAndRank(lists, statusOf);
    // m2: three signals (2nd, 1st, 1st) beats m1 (1st, 2nd) beats m3 (3rd).
    expect(first.map((h) => h.memoryId)).toEqual(['m2', 'm1', 'm3']);
    expect(first[0]!.signals).toEqual(['vector', 'fts', 'entity']);
    // Deterministic: byte-identical across repeated runs.
    expect(fuseAndRank(lists, statusOf)).toEqual(first);
  });

  it('replaced never appears (×0 — excluded from default retrieval)', () => {
    const lists: RankedList[] = [
      { signal: 'vector', ids: ['gone', 'kept'] },
      { signal: 'fts', ids: ['gone', 'kept'] },
      { signal: 'entity', ids: ['gone'] },
    ];
    const hits = fuseAndRank(lists, statuses({ gone: 'replaced', kept: 'active' }));
    expect(hits.map((h) => h.memoryId)).toEqual(['kept']);
  });

  it('outdated ranks below active at identical raw rank (×0.2 vs ×1.0)', () => {
    // Identical raw rank: each is rank 1 in exactly one signal.
    const lists: RankedList[] = [
      { signal: 'vector', ids: ['stale'] },
      { signal: 'fts', ids: ['fresh'] },
    ];
    const hits = fuseAndRank(lists, statuses({ stale: 'outdated', fresh: 'active' }));
    expect(hits.map((h) => h.memoryId)).toEqual(['fresh', 'stale']);
    expect(hits[1]!.score).toBeCloseTo(hits[0]!.score * 0.2, 10);
  });

  it('applies the full §A.5 table on equal raw ranks', () => {
    const ids = ['a-active', 'b-approved', 'c-uncertain', 'd-contradicted', 'e-outdated'];
    // Every id at rank 1 of its own signal-shaped list → equal RRF base.
    const lists: RankedList[] = ids.map((id) => ({ signal: 'fts', ids: [id] }));
    const hits = fuseAndRank(
      lists,
      statuses({
        'a-active': 'active',
        'b-approved': 'user_approved',
        'c-uncertain': 'uncertain',
        'd-contradicted': 'contradicted',
        'e-outdated': 'outdated',
      }),
    );
    const base = 1 / 61;
    const byId = Object.fromEntries(hits.map((h) => [h.memoryId, h.score]));
    expect(byId['a-active']).toBeCloseTo(base * 1.0, 10);
    expect(byId['b-approved']).toBeCloseTo(base * 1.0, 10);
    expect(byId['c-uncertain']).toBeCloseTo(base * 0.6, 10);
    expect(byId['d-contradicted']).toBeCloseTo(base * 0.4, 10);
    expect(byId['e-outdated']).toBeCloseTo(base * 0.2, 10);
    // Ties (active vs user_approved) break on id — still deterministic.
    expect(hits.map((h) => h.memoryId)).toEqual([
      'a-active',
      'b-approved',
      'c-uncertain',
      'd-contradicted',
      'e-outdated',
    ]);
  });

  it('drops ids the gated read could not resolve', () => {
    const lists: RankedList[] = [{ signal: 'vector', ids: ['visible', 'phantom'] }];
    const hits = fuseAndRank(lists, statuses({ visible: 'active' }));
    expect(hits.map((h) => h.memoryId)).toEqual(['visible']);
  });
});
