import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rewriteCaseSchema, scoreRewriteCase } from './eval-rewrite';
import type { RewriteCase } from './eval-rewrite';

const CASES_DIR = path.resolve(__dirname, '..', '..', 'eval', 'rewrite');

function loadAll(): { lang: string; file: string; parsed: RewriteCase }[] {
  const out: { lang: string; file: string; parsed: RewriteCase }[] = [];
  for (const lang of readdirSync(CASES_DIR)) {
    for (const file of readdirSync(path.join(CASES_DIR, lang))) {
      if (!file.endsWith('.json')) continue;
      out.push({
        lang,
        file,
        parsed: rewriteCaseSchema.parse(
          JSON.parse(readFileSync(path.join(CASES_DIR, lang, file), 'utf8')),
        ),
      });
    }
  }
  return out;
}

/**
 * The corpus is data, and data rots silently. These run in the unit suite so a
 * malformed case fails on every pull request rather than at the next live run.
 */
describe('query-rewrite corpus', () => {
  const cases = loadAll();

  it('parses every case, in both languages', () => {
    expect(cases.length).toBeGreaterThanOrEqual(32);
    expect(new Set(cases.map((c) => c.lang))).toEqual(new Set(['en', 'hr']));
  });

  it('pins an anchor on every case, so a relative date resolves the same forever', () => {
    for (const { parsed } of cases) {
      expect(Number.isNaN(new Date(parsed.now).getTime())).toBe(false);
    }
  });

  it('gives every case a unique id', () => {
    const ids = cases.map((c) => c.parsed.case_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every intent the router recognises, in each language', () => {
    for (const lang of ['en', 'hr']) {
      const inLang = cases.filter((c) => c.lang === lang).map((c) => c.parsed.expect);
      expect(inLang.filter((e) => e.temporal?.kind === 'previous').length).toBeGreaterThan(0);
      expect(inLang.filter((e) => e.temporal?.kind === 'point_in_time').length).toBeGreaterThan(0);
      expect(inLang.filter((e) => e.temporal?.kind === 'change_since').length).toBeGreaterThan(0);
      expect(inLang.filter((e) => e.open_loops).length).toBeGreaterThan(0);
      expect(inLang.filter((e) => e.email_reply).length).toBeGreaterThan(0);
      expect(inLang.filter((e) => e.research).length).toBeGreaterThan(0);
      expect(inLang.filter((e) => e.skill_brief).length).toBeGreaterThan(0);
      expect(inLang.filter((e) => e.small_talk).length).toBeGreaterThan(0);
      expect(inLang.filter((e) => e.question_class === 'knowledge').length).toBeGreaterThan(0);
      // The negatives: plain turns that must not be classified as anything.
      expect(
        inLang.filter(
          (e) =>
            e.question_class === 'personal' &&
            !e.temporal &&
            !e.open_loops &&
            !e.email_reply &&
            !e.research &&
            !e.skill_brief &&
            !e.small_talk,
        ).length,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('refuses a case that asserts a question class the router never reads', () => {
    expect(() =>
      rewriteCaseSchema.parse({
        case_id: 'bad',
        now: '2026-07-01T09:00:00.000Z',
        question: 'Research Adriatic Foods',
        expect: { question_class: 'knowledge', research: { topic: 'Adriatic Foods' } },
      }),
    ).toThrow();
  });

  it('requires a question class on a turn the router does route', () => {
    expect(() =>
      rewriteCaseSchema.parse({
        case_id: 'bad',
        now: '2026-07-01T09:00:00.000Z',
        question: 'What did we agree?',
        expect: {},
      }),
    ).toThrow();
  });
});

describe('scoreRewriteCase', () => {
  const personal = rewriteCaseSchema.parse({
    case_id: 'x',
    now: '2026-07-01T09:00:00.000Z',
    question: 'What did she decide?',
    expect: { question_class: 'personal', query_must_include: ['Ana'] },
  });
  const clean = {
    research: null,
    skillBrief: null,
    smallTalk: null,
    rewrite: {
      query: 'What did Ana decide?',
      entities: ['Ana'],
      questionClass: 'personal',
      temporal: null,
      openLoops: null,
      emailReply: null,
    },
  };

  it('passes a case where every assertion holds', () => {
    expect(scoreRewriteCase(personal, clean)).toEqual([]);
  });

  it('an omitted expectation asserts NULL, so a stray intent fails the case', () => {
    // This is what gives every case negative coverage for the intents it is
    // not: the veto guards are proven, not assumed.
    const strayTemporal = {
      ...clean,
      rewrite: { ...clean.rewrite, temporal: { kind: 'previous' } },
    };
    expect(scoreRewriteCase(personal, strayTemporal)).toContain('temporal previous expected none');
  });

  it('skips the rewriter half on a turn a deterministic detector pre-empted', () => {
    const researchCase = rewriteCaseSchema.parse({
      case_id: 'r',
      now: '2026-07-01T09:00:00.000Z',
      question: 'Research Adriatic Foods',
      expect: { research: { topic: 'Adriatic Foods' } },
    });
    expect(
      scoreRewriteCase(researchCase, {
        research: { topic: 'Adriatic Foods' },
        skillBrief: null,
        smallTalk: null,
        rewrite: null,
      }),
    ).toEqual([]);
  });
});
