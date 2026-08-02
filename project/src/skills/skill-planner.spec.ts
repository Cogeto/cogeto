import { describe, expect, it, vi } from 'vitest';
import type { MemoryRow } from '../memory/index';
import type { RetrievalService } from '../retrieval/index';
import type { ModelGateway } from '../model-gateway/index';
import type { ResearchService } from '../research/index';
import type { SkillRunService } from './skill-run.service';
import { ambiguousCandidates, fallbackQueries, SkillPlanner } from './skill-planner';
import { selectPagesForSubject } from './page-select';

const row = (overrides: Partial<MemoryRow>): MemoryRow =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    subjectEntity: null,
    entities: [],
    content: 'x',
    status: 'active',
    ...overrides,
  }) as MemoryRow;

describe('ambiguousCandidates (ambiguous_subject_asks, the pure rule)', () => {
  it('two distinct known entities containing the bare subject → ask', () => {
    const rows = [
      row({ subjectEntity: 'Marko Kovač', entities: ['Marko Kovač'] }),
      row({ subjectEntity: 'Marko Horvat', entities: ['Marko Horvat'] }),
    ];
    expect(ambiguousCandidates('Marko', rows)).toEqual(['Marko Horvat', 'Marko Kovač']);
  });

  it('an exact stored match means the subject is already precise', () => {
    const rows = [
      row({ subjectEntity: 'Marko Kovač', entities: ['Marko Kovač'] }),
      row({ entities: ['Marko'] }),
    ];
    expect(ambiguousCandidates('Marko', rows)).toEqual([]);
  });

  it('one candidate, whole-word only, empty subject → never ambiguous', () => {
    expect(ambiguousCandidates('Marko', [row({ entities: ['Marko Kovač'] })])).toEqual([]);
    // "Marko" must match as a whole word"Markov trg" is a different name.
    expect(
      ambiguousCandidates('Marko', [
        row({ entities: ['Markov trg'] }),
        row({ entities: ['Markovac'] }),
      ]),
    ).toEqual([]);
    expect(ambiguousCandidates('', [row({ entities: ['Marko'] })])).toEqual([]);
  });
});

describe('SkillPlanner.propose', () => {
  const gateway = { extractStructured: vi.fn() } as unknown as ModelGateway;

  it('ambiguous_subject_asks: asks BEFORE planning — no run, no queries, nothing created', async () => {
    const retrieval = {
      retrieve: vi.fn(
        async (_p: unknown, _q: unknown, opts: { rewrite?: { openLoops?: unknown } }) =>
          (opts.rewrite as { openLoops: unknown }).openLoops
            ? { memories: [], mode: 'open_loops', openLoops: [] }
            : {
                memories: [
                  { memory: row({ subjectEntity: 'Marko Kovač', entities: ['Marko Kovač'] }) },
                  { memory: row({ subjectEntity: 'Marko Horvat', entities: ['Marko Horvat'] }) },
                ],
                mode: 'entity_profile',
              },
      ),
    } as unknown as RetrievalService;
    const runs = { createRun: vi.fn() } as unknown as SkillRunService;
    const research = { proposeForSkill: vi.fn() } as unknown as ResearchService;
    const planner = new SkillPlanner(retrieval, research, runs, gateway);

    const outcome = await planner.propose(
      { userId: 'u', name: '', email: null, orgId: 'o', orgName: '', roles: [] },
      'research_brief',
      'Marko',
    );
    expect(outcome).toEqual({ status: 'ambiguous', candidates: ['Marko Horvat', 'Marko Kovač'] });
    expect(runs.createRun).not.toHaveBeenCalled();
    expect(research.proposeForSkill).not.toHaveBeenCalled();
  });

  it('an unknown skill id refuses', async () => {
    const planner = new SkillPlanner(
      { retrieve: vi.fn() } as unknown as RetrievalService,
      {} as ResearchService,
      {} as SkillRunService,
      gateway,
    );
    await expect(
      planner.propose(
        { userId: 'u', name: '', email: null, orgId: 'o', orgName: '', roles: [] },
        'nonexistent',
        'X',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('fallbackQueries (the 0044 fail-open rule)', () => {
  it('proposes deterministic identity + news queries with an honest reason', () => {
    const queries = fallbackQueries('Adriatic Foods');
    expect(queries.map((q) => q.query)).toEqual(['Adriatic Foods', 'Adriatic Foods news']);
    expect(queries.every((q) => q.reason.includes('review this query yourself'))).toBe(true);
  });
});

describe('selectPagesForSubject (relevance first, primary sources preferred)', () => {
  const results = [
    { url: 'https://news.example.org/af-story', title: 'Story', snippet: '', score: 9 },
    { url: 'https://adriaticfoods.example.org/about', title: 'About', snippet: '', score: 4 },
    { url: 'https://blog.example.org/af', title: 'Blog', snippet: '', score: 6 },
  ];

  it("the subject's own host outranks higher-scored third parties", () => {
    expect(selectPagesForSubject(results, 'Adriatic Foods', 2)).toEqual([
      'https://adriaticfoods.example.org/about',
      'https://news.example.org/af-story',
    ]);
  });

  it('falls back to pure score order when no host matches; respects k', () => {
    expect(selectPagesForSubject(results, 'Someone Else', 2)).toEqual([
      'https://news.example.org/af-story',
      'https://blog.example.org/af',
    ]);
    expect(selectPagesForSubject(results, 'Adriatic Foods', 0)).toEqual([]);
    expect(selectPagesForSubject([], 'Adriatic Foods', 3)).toEqual([]);
  });
});
