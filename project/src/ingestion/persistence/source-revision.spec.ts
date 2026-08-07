import { describe, expect, it } from 'vitest';
import {
  normalizeFilename,
  parseRevisionField,
  revisionIsLater,
  scoreRevision,
  shingleSimilarity,
  subjectOverlap,
} from './source-revision.store';

/**
 * The revision scorer (V2.2 item 5.3) — unit surface, pure basis in,
 * decision out. These pin docs/features/revisions.md verbatim: S1 links
 * auto at high, S2 proposes at medium, and everything below the bar
 * records NOTHING. The database plumbing (never-re-propose, manual
 * override) is covered by the import flow integration spec.
 */

describe('normalizeFilename', () => {
  it('folds case and strips the folder path', () => {
    expect(normalizeFilename('Reports/Q3 Final.PDF')).toBe('q3 final.pdf');
    expect(normalizeFilename('policy.pdf')).toBe('policy.pdf');
  });
});

describe('parseRevisionField / revisionIsLater', () => {
  it('parses dotted numbers under their prefixes', () => {
    expect(parseRevisionField('2')).toEqual({ scheme: 'numeric', key: [2] });
    expect(parseRevisionField('v2.1')).toEqual({ scheme: 'numeric', key: [2, 1] });
    expect(parseRevisionField('Rev 3.0.1')).toEqual({ scheme: 'numeric', key: [3, 0, 1] });
  });

  it('parses ISO-ish dates, defaulting the day', () => {
    expect(parseRevisionField('2026-07-01')).toEqual({ scheme: 'date', key: [2026, 7, 1] });
    expect(parseRevisionField('2026-07')).toEqual({ scheme: 'date', key: [2026, 7, 1] });
  });

  it('an unparseable revision corroborates nothing', () => {
    expect(parseRevisionField('final FINAL v2 (copy)')).toBeNull();
    expect(parseRevisionField('')).toBeNull();
    expect(parseRevisionField(null)).toBeNull();
  });

  it('later means strictly later under ONE shared scheme', () => {
    expect(revisionIsLater('v2', 'v1')).toBe(true);
    expect(revisionIsLater('2.1', '2')).toBe(true);
    expect(revisionIsLater('v1', 'v2')).toBe(false);
    expect(revisionIsLater('v2', 'v2')).toBe(false);
    // Mixed schemes never compare: a date is not later than a number.
    expect(revisionIsLater('2026-07-01', 'v1')).toBe(false);
  });
});

describe('subjectOverlap / shingleSimilarity', () => {
  it('overlap is Jaccard over case-folded names', () => {
    expect(subjectOverlap(['Acme', 'Q3 budget'], ['acme', 'q3 budget'])).toBe(1);
    expect(subjectOverlap(['Acme', 'Q3 budget'], ['Acme', 'staffing'])).toBeCloseTo(1 / 3);
    expect(subjectOverlap([], ['Acme'])).toBe(0);
  });

  it('an edited document scores high; a same-topic one does not', () => {
    const original =
      'The travel policy applies to all employees of the company. ' +
      'Expenses above one hundred euros require written approval from a manager. ' +
      'Receipts must be submitted within thirty days of the trip ending.';
    const edited = original.replace('thirty days', 'fourteen days');
    const sameTopic =
      'Employees travelling on business should keep their receipts. ' +
      'Managers approve expense reports once a month during the review meeting. ' +
      'The finance team publishes travel guidance every quarter for the staff.';
    expect(shingleSimilarity(original, edited)).toBeGreaterThan(0.6);
    expect(shingleSimilarity(original, sameTopic)).toBeLessThan(0.2);
  });
});

describe('scoreRevision', () => {
  const base = {
    filename: 'policy.pdf',
    revisionNew: null as string | null,
    revisionOld: null as string | null,
    subjectOverlap: null as number | null,
    classMatch: null as boolean | null,
    shingleSimilarity: null as number | null,
  };

  it('S1: comparable anchored revisions, new later — auto at high', () => {
    expect(scoreRevision({ ...base, revisionNew: 'v2', revisionOld: 'v1' })).toEqual({
      decision: 'auto',
      confidence: 'high',
    });
  });

  it('S1 is blocked when the document classes disagree', () => {
    expect(
      scoreRevision({ ...base, revisionNew: 'v2', revisionOld: 'v1', classMatch: false }),
    ).toBeNull();
  });

  it('S2: subject overlap AND class match AND structural similarity — proposed at medium', () => {
    expect(
      scoreRevision({ ...base, subjectOverlap: 0.5, classMatch: true, shingleSimilarity: 0.6 }),
    ).toEqual({ decision: 'proposed', confidence: 'medium' });
  });

  it('S2 needs every leg: any one below its threshold records nothing', () => {
    expect(
      scoreRevision({ ...base, subjectOverlap: 0.4, classMatch: true, shingleSimilarity: 0.9 }),
    ).toBeNull();
    expect(
      scoreRevision({ ...base, subjectOverlap: 0.9, classMatch: null, shingleSimilarity: 0.9 }),
    ).toBeNull();
    expect(
      scoreRevision({ ...base, subjectOverlap: 0.9, classMatch: true, shingleSimilarity: 0.5 }),
    ).toBeNull();
  });

  it('a bare filename match alone records nothing (the same-name-different-folder case)', () => {
    expect(scoreRevision(base)).toBeNull();
  });
});
