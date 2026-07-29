import { describe, expect, it } from 'vitest';
import type { ResearchRunDto } from '@cogeto/shared';
import { pickResumeRun, RESUME_WINDOW_HOURS } from './research-resume';

/**
 * research_resume: the chat page resumes ONLY an
 * approved run still in flight, to show progress. Concluded runs never resume
 * (their answer is a persistent message in the conversation);
 * seen, cancelled, proposed, and stale runs never resume either.
 */

const NOW = new Date('2026-07-25T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const run = (over: Partial<ResearchRunDto> & Pick<ResearchRunDto, 'id'>): ResearchRunDto => ({
  status: 'approved',
  intent: 'harbour fees',
  proposedQuery: 'harbour fees',
  minimisedQuery: 'harbour fees',
  minimiseReason: 'kept',
  sentQuery: 'harbour fees',
  answer: null,
  createdAt: hoursAgo(3),
  approvedAt: hoursAgo(2),
  cancelledAt: null,
  concludedAt: null,
  answerSeenAt: null,
  ...over,
});

describe('research_resume', () => {
  it('resumes an approved run still in flight; newest wins', () => {
    const runs = [
      run({ id: 'older', approvedAt: hoursAgo(10) }),
      run({ id: 'newer', approvedAt: hoursAgo(1) }),
    ];
    expect(pickResumeRun(runs, NOW)?.id).toBe('newer');
  });

  it('concluded runs never resume: their answer lives in the conversation', () => {
    const runs = [
      run({ id: 'done', status: 'concluded', answer: 'a', concludedAt: hoursAgo(1) }),
      run({
        id: 'done-unseen',
        status: 'concluded',
        answer: 'b',
        concludedAt: hoursAgo(1),
        answerSeenAt: null,
      }),
    ];
    expect(pickResumeRun(runs, NOW)).toBeNull();
  });

  it('never resumes seen, cancelled, proposed, or stale runs', () => {
    const runs = [
      // Issue #257: an orphaned run stuck in 'approved' whose surface was
      // already acknowledged must NOT haunt every chat load.
      run({ id: 'approved-but-seen', answerSeenAt: hoursAgo(1) }),
      run({ id: 'cancelled', status: 'cancelled', approvedAt: null, cancelledAt: hoursAgo(1) }),
      run({ id: 'proposed', status: 'proposed', approvedAt: null, sentQuery: null }),
      run({ id: 'stale', approvedAt: hoursAgo(RESUME_WINDOW_HOURS + 1) }),
    ];
    expect(pickResumeRun(runs, NOW)).toBeNull();
  });
});
