import { describe, expect, it } from 'vitest';
import type { SkillRunDetailDto, SkillRunDto, SkillRunStepDto } from '@cogeto/shared';
import { briefExportText, gateOpen, runIsLive, runStatusLine } from './skills-model';

const run = (status: SkillRunDto['status'], failureReason: string | null = null): SkillRunDto => ({
  id: 'r1',
  skillId: 'research_brief',
  skillVersion: 'v0001',
  skillName: 'Research a company or person before a meeting',
  subject: 'Adriatic Foods',
  status,
  failureReason,
  startedAt: '2026-07-25T10:00:00Z',
  finishedAt: null,
  createdAt: '2026-07-25T10:00:00Z',
});

const step = (over: Partial<SkillRunStepDto>): SkillRunStepDto => ({
  id: 's1',
  position: 0,
  stepKey: 'read_pages',
  kind: 'fetch_and_extract',
  status: 'running',
  title: 'Reading the selected pages',
  inputsSummary: null,
  outputsSummary: null,
  links: {},
  error: null,
  startedAt: null,
  finishedAt: null,
  ...over,
});

describe('runStatusLine (human-phrased live status)', () => {
  it('phrases each lifecycle state', () => {
    expect(runStatusLine(run('planning'))).toContain('Planning');
    expect(runStatusLine(run('awaiting_approval'))).toContain('awaiting your approval');
    expect(runStatusLine(run('completed'))).toBe('Completed');
    expect(runStatusLine(run('cancelled'))).toBe('Cancelled');
    expect(runStatusLine(run('failed', 'model unavailable'))).toBe('Failed: model unavailable');
  });

  it('a running run speaks through its current step, preferring honest progress', () => {
    expect(runStatusLine(run('running'), [step({ outputsSummary: 'Read 2 of 4 pages…' })])).toBe(
      'Read 2 of 4 pages…',
    );
    expect(runStatusLine(run('running'), [step({})])).toBe('Reading the selected pages');
    expect(runStatusLine(run('running'), [step({ status: 'failed' })])).toBe(
      'Retrying: reading the selected pages',
    );
  });
});

describe('runIsLive / gateOpen', () => {
  it('polls only while planning or running; the gate is awaiting_approval only', () => {
    expect(runIsLive('planning')).toBe(true);
    expect(runIsLive('running')).toBe(true);
    expect(runIsLive('awaiting_approval')).toBe(false);
    expect(runIsLive('completed')).toBe(false);
    expect(gateOpen(run('awaiting_approval'))).toBe(true);
    expect(gateOpen(run('running'))).toBe(false);
  });
});

describe('briefExportText', () => {
  it('exports the brief with a resolved Sources block; empty without a brief', () => {
    const detail: SkillRunDetailDto = {
      ...run('completed'),
      steps: [],
      plan: [],
      brief: 'They opened a warehouse. [W1] You agreed terms. [M1]',
      briefCitations: [
        {
          kind: 'web',
          marker: '[W1]',
          url: 'https://af.example.org/news',
          title: 'AF News',
          fetchedAt: '2026-07-25T09:00:00.000Z',
          webPageId: 'p1',
        },
        { kind: 'memory', marker: '[M1]', memoryId: 'm1' },
      ],
    };
    const text = briefExportText(detail);
    expect(text).toContain('# Research a company or person before a meeting: Adriatic Foods');
    expect(text).toContain('Sources:');
    expect(text).toContain('[W1] AF News (https://af.example.org/news, fetched 2026-07-25)');
    expect(text).toContain('[M1] memory m1');
    expect(briefExportText({ ...detail, brief: null })).toBe('');
  });
});
