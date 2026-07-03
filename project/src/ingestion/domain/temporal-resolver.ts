import * as chrono from 'chrono-node';

/**
 * Deterministic relative-date resolution (decision 0007 ruling 1; owner test
 * F8). Models never do calendar arithmetic: the extractor emits raw temporal
 * expressions verbatim, and this code resolves them against the note's
 * created_at anchor. All math is in UTC so results are host-timezone
 * independent — the golden cases pin an anchor date and must stay stable
 * forever.
 *
 * F8 rules encoded here:
 * - weekday names resolve to the NEXT occurrence strictly after the anchor
 *   date (anchor Friday 2026-07-03: "Monday" → 07-06, "Thursday" → 07-09);
 *   the anchor's own weekday resolves to +7, never to the anchor itself.
 * - "in N days/weeks/months" adds to the anchor ("in two weeks" → 07-17).
 * - "by X" is a valid_until; a plain point/valid_from expression sets valid_from.
 * - anything unresolvable leaves the field null and is reported so the memory
 *   detail drawer can flag "date could not be resolved".
 */

export type TemporalKind = 'valid_from' | 'valid_until' | 'point';

export interface TemporalExpression {
  /** The source phrase verbatim, e.g. "by Monday", "in two weeks". */
  raw: string;
  kind: TemporalKind;
}

export interface ResolvedInterval {
  validFrom?: Date;
  validUntil?: Date;
  /** Raw expressions that could not be resolved to a date. */
  unresolved: string[];
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function atUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(d: Date, days: number): Date {
  const r = atUtcMidnight(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

function addUtcMonths(d: Date, months: number): Date {
  const r = atUtcMidnight(d);
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}

/** The next occurrence of `dow` strictly after the anchor date (never the anchor). */
function nextWeekday(anchor: Date, dow: number): Date {
  const base = atUtcMidnight(anchor);
  let delta = (dow - base.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return addUtcDays(base, delta);
}

function parseCount(token: string): number | null {
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
  return NUMBER_WORDS[token] ?? null;
}

/** chrono fallback for absolute/other forms; components read in UTC (TZ-safe). */
function chronoResolve(raw: string, anchor: Date): Date | null {
  const results = chrono.parse(raw, anchor, { forwardDate: true });
  const start = results[0]?.start;
  if (!start) return null;
  const year = start.get('year');
  const month = start.get('month');
  const day = start.get('day');
  if (year == null || month == null || day == null) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Resolve one raw expression to a calendar date (UTC midnight), or null.
 * The custom pass (weekday, "in N", today/tomorrow/yesterday) is authoritative
 * and deterministic; chrono handles absolute dates as a fallback.
 */
export function resolveExpression(raw: string, anchor: Date): Date | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  if (/\btoday\b/.test(text)) return atUtcMidnight(anchor);
  if (/\btomorrow\b/.test(text)) return addUtcDays(anchor, 1);
  if (/\byesterday\b/.test(text)) return addUtcDays(anchor, -1);

  // "in N days/weeks/months" — added to the anchor.
  const inMatch = text.match(/\bin\s+([a-z]+|\d+)\s+(day|days|week|weeks|month|months)\b/);
  if (inMatch) {
    const n = parseCount(inMatch[1]!);
    const unit = inMatch[2]!;
    if (n !== null) {
      if (unit.startsWith('day')) return addUtcDays(anchor, n);
      if (unit.startsWith('week')) return addUtcDays(anchor, n * 7);
      return addUtcMonths(anchor, n);
    }
  }

  // Weekday names, with any of the usual lead-ins ("by", "next", "on", …).
  const wdMatch = text.match(
    /\b(?:by|before|on|this|next|coming|the)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
  );
  if (wdMatch) {
    return nextWeekday(anchor, WEEKDAYS[wdMatch[1]!]!);
  }

  return chronoResolve(raw, anchor);
}

/** Resolve a list of expressions, routing each by kind; collect unresolved raws. */
export function resolveTemporalExpressions(
  expressions: TemporalExpression[],
  anchor: Date,
): ResolvedInterval {
  const out: ResolvedInterval = { unresolved: [] };
  for (const expr of expressions) {
    const date = resolveExpression(expr.raw, anchor);
    if (!date) {
      out.unresolved.push(expr.raw);
      continue;
    }
    if (expr.kind === 'valid_until') out.validUntil = date;
    else out.validFrom = date; // 'valid_from' and 'point' both start the interval
  }
  return out;
}
