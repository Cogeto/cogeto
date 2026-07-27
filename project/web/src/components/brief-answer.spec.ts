import { describe, expect, it } from 'vitest';
import type { ResearchCitationDto } from '@cogeto/shared';
import { briefSegments } from './brief-answer';

const citations: ResearchCitationDto[] = [
  {
    kind: 'web',
    marker: '[W1]',
    url: 'https://af.example.org',
    title: 'AF',
    fetchedAt: '2026-07-25T09:00:00.000Z',
    webPageId: 'p1',
  },
  { kind: 'memory', marker: '[M1]', memoryId: 'm1' },
];

describe('briefSegments (issue #268)', () => {
  it('turns known markers into atomic chip segments and keeps prose intact', () => {
    const segments = briefSegments(
      '### Who they are\nA distributor. [W1] You knew. [M1]',
      citations,
    );
    expect(segments).toEqual([
      { kind: 'text', text: '### Who they are\nA distributor. ' },
      { kind: 'cite', memoryId: '[W1]' },
      { kind: 'text', text: ' You knew. ' },
      { kind: 'cite', memoryId: '[M1]' },
    ]);
  });

  it('renders (unsourced) as the canonical unsourced segment', () => {
    const segments = briefSegments('Margins are thin. (unsourced)', citations);
    expect(segments).toEqual([{ kind: 'text', text: 'Margins are thin. ' }, { kind: 'unsourced' }]);
  });

  it('an unknown marker stays literal text; empty text yields no segments', () => {
    expect(briefSegments('Odd claim. [W9]', citations)).toEqual([
      { kind: 'text', text: 'Odd claim. [W9]' },
    ]);
    expect(briefSegments('', citations)).toEqual([]);
  });
});
