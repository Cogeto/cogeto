import { describe, expect, it } from 'vitest';
import type { ResearchRunDto } from '@cogeto/shared';
import { pickResumeRun, RESUME_WINDOW_HOURS } from './research-resume';

/**
 * research_resume (decision 0057): which run the chat page picks back up —
 * an approved run still in flight, or a concluded one whose stored answer was
 * never seen; stale and terminal-and-seen runs never resume.
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
  it('resumes an approved run still in flight', () => {
    expect(pickResumeRun([run({ id: 'r1' })], NOW)?.id).toBe('r1');
  });

  it('resumes a concluded run whose stored answer was never seen; newest wins', () => {
    const runs = [
      run({ id: 'older', status: 'concluded', answer: 'a', concludedAt: hoursAgo(10) }),
      run({ id: 'newer', status: 'concluded', answer: 'b', concludedAt: hoursAgo(1) }),
    ];
    expect(pickResumeRun(runs, NOW)?.id).toBe('newer');
  });

  it('never resumes seen, cancelled, proposed, or stale runs', () => {
    const runs = [
      run({
        id: 'seen',
        status: 'concluded',
        answer: 'a',
        concludedAt: hoursAgo(1),
        answerSeenAt: hoursAgo(1),
      }),
      run({ id: 'cancelled', status: 'cancelled', approvedAt: null, cancelledAt: hoursAgo(1) }),
      run({ id: 'proposed', status: 'proposed', approvedAt: null, sentQuery: null }),
      run({ id: 'stale', approvedAt: hoursAgo(RESUME_WINDOW_HOURS + 1) }),
      run({
        id: 'stale-concluded',
        status: 'concluded',
        answer: 'a',
        concludedAt: hoursAgo(RESUME_WINDOW_HOURS + 1),
      }),
    ];
    expect(pickResumeRun(runs, NOW)).toBeNull();
  });
});
