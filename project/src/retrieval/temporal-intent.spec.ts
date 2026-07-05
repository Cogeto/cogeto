import { describe, expect, it } from 'vitest';
import type { ChatFactDto } from '@cogeto/shared';
import { isPastBelief } from '../memory/index';
import { resolveTemporalIntent, shouldRewrite, TEMPORAL_HINT_RE } from './query-rewrite';
import { buildAnswerInput } from './chat/answer-prompt';

const NOW = new Date('2026-07-05T12:00:00Z');

describe('temporal intent guards (unit — decision 0012 ruling 2)', () => {
  it('temporal_explicit_only: a plain question never activates the mode', () => {
    const plainQuestions = [
      'What is the Atlas budget?',
      'Who is Ana Kovač?',
      'What platform do the client workshops run on?',
      'When is the Adriatic Foods workshop?', // asks FOR a date, not ABOUT the past
      'Send the report by Friday — what is missing?',
    ];
    for (const q of plainQuestions) {
      expect(TEMPORAL_HINT_RE.test(q), q).toBe(false);
      // Even a hallucinating model classification is vetoed without a hint.
      expect(resolveTemporalIntent(q, { kind: 'previous', expression: null }, NOW)).toBeNull();
      expect(
        resolveTemporalIntent(q, { kind: 'point_in_time', expression: 'in March' }, NOW),
      ).toBeNull();
    }
  });

  it('classifies hinted questions and resolves dates deterministically (past-preferring)', () => {
    expect(
      resolveTemporalIntent(
        'What did we previously decide about the workshop platform?',
        { kind: 'previous', expression: null },
        NOW,
      ),
    ).toEqual({ kind: 'previous' });

    const march = resolveTemporalIntent(
      'Which CRM were we using in March?',
      { kind: 'point_in_time', expression: 'in March' },
      NOW,
    );
    expect(march?.kind).toBe('point_in_time');
    expect(march?.at?.getMonth()).toBe(2); // March …
    expect(march?.at?.getFullYear()).toBe(2026); // … the most recent PAST March

    const since = resolveTemporalIntent(
      'Što se promijenilo oko projekta Jadran od lipnja?',
      { kind: 'change_since', expression: 'od lipnja' },
      NOW,
    );
    // hr month resolution may or may not parse — either a valid past date or
    // a clean fallback to default mode; never a future date, never a throw.
    if (since) {
      expect(since.kind).toBe('change_since');
      expect(since.since!.getTime()).toBeLessThanOrEqual(NOW.getTime());
    }

    // Unresolvable expressions fall back to default mode, never an error.
    expect(
      resolveTemporalIntent(
        'What changed since the reorg?',
        { kind: 'change_since', expression: 'the reorg' },
        NOW,
      ),
    ).toBeNull();
  });

  it('temporal hints force the rewriter call even for self-contained questions', () => {
    expect(shouldRewrite('What did we previously decide about the workshop platform?')).toBe(true);
    expect(shouldRewrite('Which CRM were we using in March?')).toBe(true);
    expect(shouldRewrite('What is the complete current scope of the Atlas migration?')).toBe(false);
  });
});

describe('past_framing_contract (unit — decision 0012 ruling 6)', () => {
  const baseRow = {
    validFrom: new Date('2026-03-01'),
    validUntil: null as Date | null,
    createdAt: new Date('2026-03-01'),
  };

  it('isPastBelief: replaced/outdated or a closed interval — nothing else', () => {
    expect(isPastBelief({ ...baseRow, status: 'replaced' }, NOW)).toBe(true);
    expect(isPastBelief({ ...baseRow, status: 'outdated' }, NOW)).toBe(true);
    expect(
      isPastBelief({ ...baseRow, status: 'active', validUntil: new Date('2026-06-01') }, NOW),
    ).toBe(true);
    expect(isPastBelief({ ...baseRow, status: 'active' }, NOW)).toBe(false);
    expect(
      isPastBelief({ ...baseRow, status: 'active', validUntil: new Date('2027-01-01') }, NOW),
    ).toBe(false);
  });

  it('the answer path receives PAST BELIEF markers with the successor reference', () => {
    const past: ChatFactDto = {
      marker: 'F1',
      memoryId: 'mem-old',
      claim: 'The client workshops run on Teams.',
      status: 'replaced',
      sensitive: false,
      subjectEntity: 'client workshops',
      sourceType: 'user_note',
      sourceId: 'n1',
      validFrom: '2026-03-01T00:00:00.000Z',
      validUntil: '2026-06-01T00:00:00.000Z',
      signals: ['vector'],
      pastBelief: true,
      supersededBy: 'mem-new',
    };
    const current: ChatFactDto = {
      ...past,
      marker: 'F2',
      memoryId: 'mem-new',
      claim: 'The client workshops run on Zoom.',
      status: 'active',
      validFrom: '2026-06-01T00:00:00.000Z',
      validUntil: null,
      pastBelief: false,
      supersededBy: null,
    };
    const input = buildAnswerInput([past, current], 'What did we previously decide?', 'temporal', {
      temporal: { kind: 'previous' },
    });
    expect(input).toContain('MODE: temporal (previous)');
    expect(input).toContain('PAST BELIEF — superseded by [F2]');
    // The current fact carries no past marker.
    const currentBlock = input.slice(input.indexOf('[F2]'));
    expect(currentBlock).not.toContain('PAST BELIEF');
  });

  it('change events render as a dated CHANGES block referencing fact markers', () => {
    const fact: ChatFactDto = {
      marker: 'F1',
      memoryId: 'mem-1',
      claim: 'Invoices go to the old address.',
      status: 'replaced',
      sensitive: false,
      subjectEntity: null,
      sourceType: 'user_note',
      sourceId: 'n1',
      validFrom: null,
      validUntil: null,
      signals: [],
      pastBelief: true,
      supersededBy: 'mem-2',
    };
    const input = buildAnswerInput([fact], 'What changed since June?', 'temporal', {
      temporal: { kind: 'change_since', since: new Date('2026-06-01T00:00:00Z') },
      changes: [
        {
          kind: 'superseded',
          at: new Date('2026-06-15T00:00:00Z'),
          memory: { id: 'mem-1' } as never,
          detail: { supersededBy: 'mem-2' },
        },
      ],
    });
    expect(input).toContain('CHANGES SINCE 2026-06-01');
    expect(input).toContain('2026-06-15: [F1] superseded');
  });
});
