import { describe, expect, it } from 'vitest';
import type { AmbiguityDecisionDto, ChatFactDto } from '@cogeto/shared';
import { buildFanoutAnswer, matchOfferedSubjects, silentPreamble } from './fanout-answer';

/**
 * The server-authored fan-out and silence texts (V2.3 item 6.3, issue B):
 * deterministic, localized, carrying REAL canonical citation tokens so the
 * chips render like every other citation.
 */

function fact(over: Partial<ChatFactDto> & { memoryId: string }): ChatFactDto {
  return {
    marker: 'F1',
    claim: 'The fastening torque is 3.2 mm.',
    status: 'active',
    scope: 'private',
    ownerId: 'user-1',
    ownerName: null,
    sensitive: false,
    subjectEntity: 'VX-9',
    sourceType: 'file',
    sourceId: 'src-1',
    validFrom: null,
    validUntil: null,
    signals: ['vector'],
    pastBelief: false,
    supersededBy: null,
    ...over,
  };
}

function decision(over: Partial<AmbiguityDecisionDto> = {}): AmbiguityDecisionDto {
  return {
    branch: 'fan_out',
    clusters: [
      {
        subject: 'VX-9',
        key: 'vx-9',
        relevance: 0.8,
        entityNamed: false,
        fused: 0.03,
        size: 2,
        topMemoryId: 'mem-a',
        shown: true,
      },
      {
        subject: 'SEN-210',
        key: 'sen-210',
        relevance: 0.75,
        entityNamed: false,
        fused: 0.028,
        size: 1,
        topMemoryId: 'mem-b',
        shown: true,
      },
    ],
    named: [],
    capped: false,
    configVersion: 1,
    embeddingModel: 'test-embed',
    ...over,
  };
}

const FACTS = new Map<string, ChatFactDto>([
  ['mem-a', fact({ memoryId: 'mem-a' })],
  [
    'mem-b',
    fact({ memoryId: 'mem-b', subjectEntity: 'SEN-210', claim: 'The fastening torque is 3.4 mm.' }),
  ],
]);

describe('buildFanoutAnswer', () => {
  it('writes one line per shown cluster with subject, fact and real citation', () => {
    const text = buildFanoutAnswer(decision(), FACTS, 'en');
    expect(text).toContain('**VX-9**: The fastening torque is 3.2 mm. {{cite:mem-a}}');
    expect(text).toContain('**SEN-210**: The fastening torque is 3.4 mm. {{cite:mem-b}}');
    expect(text.indexOf('VX-9')).toBeLessThan(text.indexOf('SEN-210')); // score order
    expect(text.trimEnd().endsWith('Which did you mean?')).toBe(true);
  });

  it('carries a verdict word when the fact deviates from plain active', () => {
    const facts = new Map(FACTS);
    facts.set('mem-b', { ...facts.get('mem-b')!, status: 'uncertain' });
    const text = buildFanoutAnswer(decision(), facts, 'en');
    expect(text).toContain('{{cite:mem-b}} (unconfirmed)');
    expect(text).not.toContain('{{cite:mem-a}} (');
  });

  it('marks a past belief so a fan-out line can hold an outdated claim honestly', () => {
    const facts = new Map(FACTS);
    facts.set('mem-a', { ...facts.get('mem-a')!, pastBelief: true });
    const text = buildFanoutAnswer(decision(), facts, 'en');
    expect(text).toContain('{{cite:mem-a}} (no longer current)');
  });

  it('states the cap plainly when more subjects matched than are shown', () => {
    const capped = decision({
      capped: true,
      clusters: [
        ...decision().clusters,
        {
          subject: 'PWR-3100',
          key: 'pwr-3100',
          relevance: 0.7,
          entityNamed: false,
          fused: 0.02,
          size: 1,
          topMemoryId: 'mem-c',
          shown: false,
        },
      ],
    });
    const text = buildFanoutAnswer(capped, FACTS, 'en');
    expect(text).toContain('1 more subject matched.');
  });

  it('never renders the unanchored bucket or an unfetchable fact as a line', () => {
    const withNoise = decision({
      clusters: [
        ...decision().clusters,
        {
          subject: '',
          key: '',
          relevance: 0.7,
          entityNamed: false,
          fused: 0.01,
          size: 3,
          topMemoryId: 'mem-x',
          shown: false,
        },
      ],
    });
    const text = buildFanoutAnswer(withNoise, FACTS, 'en');
    expect(text).not.toContain('mem-x');
    expect(text.match(/\{\{cite:/g)).toHaveLength(2);
  });
});

describe('silentPreamble', () => {
  it('states corpus silence and the not-from-your-sources banner in one place', () => {
    const text = silentPreamble('en');
    expect(text).toContain('nothing about this in your sources');
    expect(text).toContain('not from your sources');
  });
});

describe('matchOfferedSubjects', () => {
  it('matches a reply naming an offered subject, fold-insensitively', () => {
    expect(matchOfferedSubjects('the vx-9, please', decision())).toEqual(['VX-9']);
  });

  it('matches inside a longer reply on token boundaries only', () => {
    expect(matchOfferedSubjects('I meant the SEN-210 datasheet', decision())).toEqual(['SEN-210']);
    expect(matchOfferedSubjects('the SEN-2109 one', decision())).toEqual([]);
  });

  it('returns every named subject when the reply compares them', () => {
    expect(matchOfferedSubjects('both VX-9 and SEN-210', decision())).toEqual(['VX-9', 'SEN-210']);
  });

  it('matches nothing without a prior fan-out', () => {
    expect(matchOfferedSubjects('the VX-9', null)).toEqual([]);
    expect(matchOfferedSubjects('the VX-9', decision({ branch: 'dominant' }))).toEqual([]);
  });

  it('ignores hidden clusters and the unanchored bucket', () => {
    const prior = decision({
      clusters: [
        { ...decision().clusters[0]!, shown: false },
        {
          subject: '',
          key: '',
          relevance: 0.5,
          entityNamed: false,
          fused: 0.01,
          size: 1,
          topMemoryId: 'mem-x',
          shown: true,
        },
      ],
    });
    expect(matchOfferedSubjects('the VX-9', prior)).toEqual([]);
  });
});
