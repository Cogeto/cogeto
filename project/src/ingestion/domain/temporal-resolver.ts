import * as chrono from 'chrono-node';

/**
 * Deterministic relative-date resolution (decision 0007 ruling 1; owner test
 * F8). Models never do calendar arithmetic: the extractor emits raw temporal
 * expressions verbatim, and this code resolves them against the note's
 * created_at anchor. The anchor is a UTC instant; the calendar date it lands on
 * is computed in the configured INSTANCE TIMEZONE (QS-32, default Europe/Zagreb)
 * so "today" for a note written at 23:30 local resolves to the local calendar
 * day, not the UTC one. Once the local calendar date is fixed, all arithmetic is
 * UTC-midnight math so results stay host-timezone independent — the golden cases
 * pin an anchor date (mid-day, so the local date matches UTC) and must stay
 * stable forever.
 *
 * F8 rules encoded here:
 * - weekday names resolve to the NEXT occurrence strictly after the anchor
 *   date (anchor Friday 2026-07-03: "Monday" → 07-06, "Thursday" → 07-09);
 *   the anchor's own weekday resolves to +7, never to the anchor itself.
 * - "last/past/previous <weekday>" resolves BACKWARD to the most recent prior
 *   occurrence (QS-29): anchor Friday 2026-07-03, "last Monday" → 06-29.
 * - "in N days/weeks/months" adds to the anchor ("in two weeks" → 07-17);
 *   "N days/weeks/months ago" subtracts ("two weeks ago" → 06-19).
 * - "by X" is a valid_until; a plain point/valid_from expression sets valid_from.
 * - anything unresolvable leaves the field null and is reported so the memory
 *   detail drawer can flag "date could not be resolved".
 */

/** Default instance timezone for calendar-date resolution (QS-32). */
export const DEFAULT_TIMEZONE = 'Europe/Zagreb';

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

/**
 * The calendar date the anchor lands on in `timeZone`, as UTC midnight of that
 * local date (QS-32). Using Intl to read the local Y/M/D keeps the result a UTC
 * instant whose `toISOString().slice(0,10)` IS the local calendar date, so all
 * downstream UTC-midnight arithmetic stays timezone-independent and the golden
 * cases stay stable.
 */
function zonedMidnight(d: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)!.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
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

/** The next occurrence of `dow` strictly after the base date (never the base). */
function nextWeekday(base: Date, dow: number): Date {
  let delta = (dow - base.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return addUtcDays(base, delta);
}

/** The previous occurrence of `dow` strictly before the base date (QS-29). */
function prevWeekday(base: Date, dow: number): Date {
  let delta = (base.getUTCDay() - dow + 7) % 7;
  if (delta === 0) delta = 7;
  return addUtcDays(base, -delta);
}

function parseCount(token: string): number | null {
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
  return NUMBER_WORDS[token] ?? null;
}

/** chrono fallback for absolute/other forms; components read in UTC (TZ-safe). */
function chronoResolve(raw: string, base: Date, forward: boolean): Date | null {
  const results = chrono.parse(raw, base, { forwardDate: forward });
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
export function resolveExpression(
  raw: string,
  anchor: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): Date | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  // Fix the anchor to its calendar date in the instance timezone (QS-32); all
  // arithmetic below is UTC-midnight math on this normalized base.
  const base = zonedMidnight(anchor, timeZone);

  if (/\btoday\b/.test(text)) return base;
  if (/\btomorrow\b/.test(text)) return addUtcDays(base, 1);
  if (/\byesterday\b/.test(text)) return addUtcDays(base, -1);

  // "N days/weeks/months ago" — subtracted from the anchor (QS-29). Checked
  // before "in N" so a stray "in ... ago" can't be misrouted.
  const agoMatch = text.match(/\b([a-z]+|\d+)\s+(day|days|week|weeks|month|months)\s+ago\b/);
  if (agoMatch) {
    const n = parseCount(agoMatch[1]!);
    const unit = agoMatch[2]!;
    if (n !== null) {
      if (unit.startsWith('day')) return addUtcDays(base, -n);
      if (unit.startsWith('week')) return addUtcDays(base, -n * 7);
      return addUtcMonths(base, -n);
    }
  }

  // "in N days/weeks/months" — added to the anchor.
  const inMatch = text.match(/\bin\s+([a-z]+|\d+)\s+(day|days|week|weeks|month|months)\b/);
  if (inMatch) {
    const n = parseCount(inMatch[1]!);
    const unit = inMatch[2]!;
    if (n !== null) {
      if (unit.startsWith('day')) return addUtcDays(base, n);
      if (unit.startsWith('week')) return addUtcDays(base, n * 7);
      return addUtcMonths(base, n);
    }
  }

  // Weekday names, with any of the usual lead-ins. "last/past/previous" resolve
  // BACKWARD (QS-29); every other lead-in resolves forward.
  const wdMatch = text.match(
    /\b(last|past|previous|by|before|on|this|next|coming|the)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
  );
  if (wdMatch) {
    const lead = wdMatch[1];
    const dow = WEEKDAYS[wdMatch[2]!]!;
    const backward = lead === 'last' || lead === 'past' || lead === 'previous';
    return backward ? prevWeekday(base, dow) : nextWeekday(base, dow);
  }

  // chrono fallback for absolute/other forms. Backward-leaning phrases disable
  // forwardDate so chrono resolves "last …"/"… ago" into the past (QS-29).
  const forward = !/\b(ago|last|past|previous)\b/.test(text);
  return chronoResolve(raw, base, forward);
}

/** Resolve a list of expressions, routing each by kind; collect unresolved raws. */
export function resolveTemporalExpressions(
  expressions: TemporalExpression[],
  anchor: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): ResolvedInterval {
  const out: ResolvedInterval = { unresolved: [] };
  for (const expr of expressions) {
    const date = resolveExpression(expr.raw, anchor, timeZone);
    if (!date) {
      out.unresolved.push(expr.raw);
      continue;
    }
    if (expr.kind === 'valid_until') out.validUntil = date;
    else out.validFrom = date; // 'valid_from' and 'point' both start the interval
  }
  return out;
}
