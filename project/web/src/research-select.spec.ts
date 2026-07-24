import { describe, expect, it } from 'vitest';
import { selectTopByScore } from '@cogeto/shared';
import type { DiscoveredPageDto } from '@cogeto/shared';

const page = (url: string, score: number | null): DiscoveredPageDto => ({
  url,
  title: url,
  snippet: '',
  score,
});

/**
 * Auto-selection of the best sources by relevance (decision 0050) — the pure
 * function that lets research run without asking the user to pick.
 */
describe('selectTopByScore', () => {
  it('picks the highest-scored first, capped at k', () => {
    const results = [page('a', 0.5), page('b', 2.1), page('c', 1.0), page('d', 3.0)];
    expect(selectTopByScore(results, 3)).toEqual(['d', 'b', 'c']);
  });

  it('breaks ties by discovery order and sorts missing scores last', () => {
    const results = [page('a', null), page('b', 1.0), page('c', 1.0), page('d', null)];
    expect(selectTopByScore(results, 3)).toEqual(['b', 'c', 'a']);
  });

  it('returns fewer than k when there are fewer results', () => {
    expect(selectTopByScore([page('only', 1)], 3)).toEqual(['only']);
    expect(selectTopByScore([], 3)).toEqual([]);
  });
});
