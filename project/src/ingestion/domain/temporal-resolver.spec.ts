import { describe, expect, it } from 'vitest';
import {
  resolveExpression,
  resolveTemporalExpressions,
  type TemporalExpression,
} from './temporal-resolver';

/**
 * F8 (owner test): with note anchor 2026-07-03 (a Friday), relative dates must
 * resolve deterministically. These are the exact failing triples plus the
 * edge cases the rule implies. The anchor is pinned in the case, never "today",
 * so these assertions hold forever.
 */

const ANCHOR = new Date('2026-07-03T09:30:00.000Z'); // Friday
const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

describe('temporal resolver (F8 — deterministic relative dates)', () => {
  it('resolves the three F8 triples exactly', () => {
    // "by Monday" → the next Monday strictly after Fri 07-03 → 07-06 (was 07-07).
    expect(iso(resolveExpression('by Monday', ANCHOR))).toBe('2026-07-06');
    // "next Thursday" → next Thursday strictly after → 07-09.
    expect(iso(resolveExpression('next Thursday', ANCHOR))).toBe('2026-07-09');
    // "in two weeks" → anchor + 14 days → 07-17 (was left unresolved).
    expect(iso(resolveExpression('in two weeks', ANCHOR))).toBe('2026-07-17');
  });

  it('weekday resolves to the NEXT occurrence strictly after the anchor', () => {
    // Every weekday from the Friday anchor.
    expect(iso(resolveExpression('Saturday', ANCHOR))).toBe('2026-07-04');
    expect(iso(resolveExpression('Sunday', ANCHOR))).toBe('2026-07-05');
    expect(iso(resolveExpression('Monday', ANCHOR))).toBe('2026-07-06');
    expect(iso(resolveExpression('Thursday', ANCHOR))).toBe('2026-07-09');
    // The anchor's own weekday (Friday) resolves to +7, never the anchor itself.
    expect(iso(resolveExpression('Friday', ANCHOR))).toBe('2026-07-10');
    expect(iso(resolveExpression('by Friday', ANCHOR))).toBe('2026-07-10');
  });

  it('adds "in N days/weeks/months" to the anchor, digits or words', () => {
    expect(iso(resolveExpression('in 3 days', ANCHOR))).toBe('2026-07-06');
    expect(iso(resolveExpression('in one week', ANCHOR))).toBe('2026-07-10');
    expect(iso(resolveExpression('in 2 weeks', ANCHOR))).toBe('2026-07-17');
    // Month arithmetic crosses the month boundary correctly.
    expect(iso(resolveExpression('in two months', ANCHOR))).toBe('2026-09-03');
  });

  it('handles today / tomorrow / yesterday against the anchor', () => {
    expect(iso(resolveExpression('today', ANCHOR))).toBe('2026-07-03');
    expect(iso(resolveExpression('tomorrow', ANCHOR))).toBe('2026-07-04');
    expect(iso(resolveExpression('yesterday', ANCHOR))).toBe('2026-07-02');
  });

  it('resolves absolute dates via chrono, anchored for the year', () => {
    expect(iso(resolveExpression('July 20', ANCHOR))).toBe('2026-07-20');
    expect(iso(resolveExpression('2026-08-01', ANCHOR))).toBe('2026-08-01');
  });

  it('crosses month and year boundaries with "in N days"', () => {
    const julyEnd = new Date('2026-07-30T12:00:00.000Z'); // Thursday
    expect(iso(resolveExpression('in 5 days', julyEnd))).toBe('2026-08-04');
    const dec = new Date('2026-12-30T12:00:00.000Z');
    expect(iso(resolveExpression('in one week', dec))).toBe('2027-01-06');
  });

  it('resolves a weekday when the anchor IS that weekday to +7 (month boundary)', () => {
    // 2026-08-31 is a Monday; "Monday" → the following Monday, 2026-09-07.
    const monday = new Date('2026-08-31T08:00:00.000Z');
    expect(monday.getUTCDay()).toBe(1);
    expect(iso(resolveExpression('Monday', monday))).toBe('2026-09-07');
  });

  it('returns null for expressions it cannot resolve', () => {
    expect(resolveExpression('sometime soon', ANCHOR)).toBeNull();
    expect(resolveExpression('', ANCHOR)).toBeNull();
    expect(resolveExpression('when the budget lands', ANCHOR)).toBeNull();
  });

  it('routes expressions by kind and collects the unresolved ones', () => {
    const exprs: TemporalExpression[] = [
      { raw: 'by Monday', kind: 'valid_until' },
      { raw: 'next Thursday', kind: 'valid_from' },
      { raw: 'whenever it suits', kind: 'point' },
    ];
    const result = resolveTemporalExpressions(exprs, ANCHOR);
    expect(iso(result.validUntil ?? null)).toBe('2026-07-06');
    expect(iso(result.validFrom ?? null)).toBe('2026-07-09');
    expect(result.unresolved).toEqual(['whenever it suits']);
  });

  it('treats a point expression as valid_from', () => {
    const result = resolveTemporalExpressions([{ raw: 'in two weeks', kind: 'point' }], ANCHOR);
    expect(iso(result.validFrom ?? null)).toBe('2026-07-17');
    expect(result.validUntil).toBeUndefined();
  });
});
