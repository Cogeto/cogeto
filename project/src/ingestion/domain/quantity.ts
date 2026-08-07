/**
 * Deterministic numeric-and-unit reasoning for contradiction detection over
 * specifications (V2.3 item 6.1). Models never do arithmetic or unit
 * conversion: this pure, dependency-free module parses quantities ("3,2 mm",
 * "230 V ±5%", "najmanje 10 kW") out of fact text in both English and
 * Croatian number conventions, converts them to base units, and compares two
 * claims with a precision tolerance derived from the coarsest stated
 * decimals, so "3.2 mm" vs "3.20 mm" agrees and "3.2 mm" vs "3.4 mm"
 * conflicts. Anything that cannot be called deterministically is an explicit
 * `undecided` reason, never a guess: an ambiguous separator ("1,200" reads
 * 1200 in English and 1.2 in Croatian) only decides when both readings
 * decide identically, and a Jaccard slot check over the residual
 * (non-numeric) text refuses to compare quantities that talk about different
 * things. Zero dependencies by design: the pipeline driver, the dreaming
 * driver, and the eval harness must apply exactly the same gate before any
 * model call.
 */

export type QuantityValue =
  | { kind: 'point'; value: number }
  | { kind: 'range'; low: number; high: number }
  | { kind: 'min'; value: number }
  | { kind: 'max'; value: number };

export type Dimension =
  | 'length'
  | 'mass'
  | 'volume'
  | 'time'
  | 'temperature'
  | 'current'
  | 'voltage'
  | 'power'
  | 'energy'
  | 'frequency'
  | 'pressure'
  | 'percentage'
  | 'currency_eur'
  | 'currency_usd'
  | 'currency_gbp'
  | 'data'
  | 'count';

export interface ParsedQuantity {
  /** In BASE units of the dimension (converted). */
  value: QuantityValue;
  dimension: Dimension;
  /** The canonical symbol of the unit AS STATED (e.g. 'mm'). */
  unit: string;
  /** "~", "approx.", "about", "cca", "oko", "približno" near the number. */
  approximate: boolean;
  /** Decimal places of the coarsest stated number, BEFORE conversion; drives the tolerance. */
  statedDecimals: number;
  /** Conversion factor applied (stated unit to base unit); 1 for base units. */
  factor: number;
  /** The exact matched substring. */
  raw: string;
  /** Match start offset in the input. */
  index: number;
  /** The construct in its stated unit, for rendering (describeQuantities). */
  stated: QuantityValue;
  /** Present when a separator reads two ways (en vs hr): the alternate reading. */
  ambiguous?: { value: QuantityValue; stated: QuantityValue; statedDecimals: number };
}

export type QuantityDecision =
  | { decision: 'conflict'; dimension: Dimension; aRaw: string; bRaw: string }
  | { decision: 'agreement'; dimension: Dimension; aRaw: string; bRaw: string }
  | { decision: 'undecided'; reason: UndecidedReason };

export type UndecidedReason =
  | 'no_quantities'
  | 'one_sided'
  | 'no_shared_dimension'
  | 'multiple_per_dimension'
  | 'ambiguous_number'
  | 'different_slot'
  | 'bounds_only';

interface UnitDef {
  /** Canonical symbol reported on ParsedQuantity.unit. */
  symbol: string;
  dimension: Dimension;
  /** Linear scale to base; for temperature this is the DELTA scale (drives tolerances). */
  factor: number;
  /** Affine override for absolute conversion (temperature only). */
  toBase?: (v: number) => number;
  /** Unit is valid only when directly attached to the number (bare K rule). */
  abutOnly?: boolean;
}

const BASE_SYMBOL: Record<Dimension, string> = {
  length: 'm',
  mass: 'kg',
  volume: 'l',
  time: 's',
  temperature: '°C',
  current: 'A',
  voltage: 'V',
  power: 'W',
  energy: 'Wh',
  frequency: 'Hz',
  pressure: 'Pa',
  percentage: '%',
  currency_eur: 'EUR',
  currency_usd: 'USD',
  currency_gbp: 'GBP',
  data: 'B',
  count: 'kom',
};

/**
 * Token to unit. Matching is case-sensitive throughout because collisions
 * are case-borne (mW vs MW, mm vs m, K vs k-prefixes). Bare B, bare C/F,
 * J and day words are deliberately absent: too collision-prone in prose.
 */
const UNIT_LIST: ReadonlyArray<readonly [string[], string, Dimension, number, Partial<UnitDef>?]> =
  [
    [['mm'], 'mm', 'length', 0.001],
    [['cm'], 'cm', 'length', 0.01],
    [['dm'], 'dm', 'length', 0.1],
    [['m'], 'm', 'length', 1],
    [['km'], 'km', 'length', 1000],
    [['µm', 'um'], 'µm', 'length', 1e-6],
    [['nm'], 'nm', 'length', 1e-9],
    [['in', 'inch', '"'], 'in', 'length', 0.0254],
    [['ft'], 'ft', 'length', 0.3048],
    [['mg'], 'mg', 'mass', 1e-6],
    [['g'], 'g', 'mass', 0.001],
    [['dag'], 'dag', 'mass', 0.01],
    [['kg'], 'kg', 'mass', 1],
    [['t'], 't', 'mass', 1000],
    [['ml'], 'ml', 'volume', 0.001],
    [['cl'], 'cl', 'volume', 0.01],
    [['dl'], 'dl', 'volume', 0.1],
    [['l', 'L'], 'l', 'volume', 1],
    [['m3', 'm³'], 'm³', 'volume', 1000],
    [['ms'], 'ms', 'time', 0.001],
    [['s', 'sec'], 's', 'time', 1],
    [['min'], 'min', 'time', 60],
    [['h'], 'h', 'time', 3600],
    [['°C'], '°C', 'temperature', 1],
    [['°F'], '°F', 'temperature', 5 / 9, { toBase: (v: number): number => ((v - 32) * 5) / 9 }],
    [['K'], 'K', 'temperature', 1, { toBase: (v: number): number => v - 273.15, abutOnly: true }],
    [['mA'], 'mA', 'current', 0.001],
    [['A'], 'A', 'current', 1],
    [['mV'], 'mV', 'voltage', 0.001],
    [['V'], 'V', 'voltage', 1],
    [['kV'], 'kV', 'voltage', 1000],
    [['mW'], 'mW', 'power', 0.001],
    [['W'], 'W', 'power', 1],
    [['kW'], 'kW', 'power', 1000],
    [['MW'], 'MW', 'power', 1e6],
    [['Wh'], 'Wh', 'energy', 1],
    [['kWh'], 'kWh', 'energy', 1000],
    [['MWh'], 'MWh', 'energy', 1e6],
    [['Hz'], 'Hz', 'frequency', 1],
    [['kHz'], 'kHz', 'frequency', 1e3],
    [['MHz'], 'MHz', 'frequency', 1e6],
    [['GHz'], 'GHz', 'frequency', 1e9],
    [['Pa'], 'Pa', 'pressure', 1],
    [['kPa'], 'kPa', 'pressure', 1e3],
    [['MPa'], 'MPa', 'pressure', 1e6],
    [['bar'], 'bar', 'pressure', 1e5],
    [['mbar'], 'mbar', 'pressure', 100],
    [['psi'], 'psi', 'pressure', 6894.757],
    [['%'], '%', 'percentage', 1],
    // The word forms specifications actually use ("plus or minus 5 percent",
    // "5 posto"); canonical symbol stays '%'.
    [['percent', 'posto'], '%', 'percentage', 1],
    [['‰'], '‰', 'percentage', 0.1],
    [['EUR', 'eur', 'eura', '€'], 'EUR', 'currency_eur', 1],
    [['USD', '$'], 'USD', 'currency_usd', 1],
    [['GBP', '£'], 'GBP', 'currency_gbp', 1],
    [['KB'], 'KB', 'data', 1e3],
    [['MB'], 'MB', 'data', 1e6],
    [['GB'], 'GB', 'data', 1e9],
    [['TB'], 'TB', 'data', 1e12],
    [['KiB'], 'KiB', 'data', 1024],
    [['MiB'], 'MiB', 'data', 1024 ** 2],
    [['GiB'], 'GiB', 'data', 1024 ** 3],
    [['TiB'], 'TiB', 'data', 1024 ** 4],
    [['kom', 'komada'], 'kom', 'count', 1],
    [['pcs'], 'pcs', 'count', 1],
  ];

const UNIT_TOKENS: ReadonlyMap<string, UnitDef> = (() => {
  const map = new Map<string, UnitDef>();
  for (const [tokens, symbol, dimension, factor, extra] of UNIT_LIST) {
    for (const token of tokens) {
      map.set(token, { symbol, dimension, factor, ...extra });
    }
  }
  return map;
})();

/** Longest token first so 'mm' wins over 'm', 'inch' over 'in', 'sec' over 's'. */
const SORTED_UNIT_TOKENS: readonly string[] = [...UNIT_TOKENS.keys()].sort(
  (a, b) => b.length - a.length,
);

function toBase(def: UnitDef, v: number): number {
  return def.toBase ? def.toBase(v) : v * def.factor;
}

interface NumberReading {
  value: number;
  decimals: number;
}

interface ScannedNumber {
  index: number;
  raw: string;
  /** One reading, or two when the separator is ambiguous (English reading first). */
  readings: NumberReading[];
}

/**
 * One number token: optional sign, digits, optional space-thousands groups
 * (exactly three digits each), optional dot/comma groups classified later.
 * The lookbehind refuses digits glued to a word ("Windows11") and a sign
 * glued to a digit ("3.2-3.4" keeps the '-' as a range connector).
 */
const NUMBER_RE = /(?<![A-Za-z0-9_])-?\d+(?:[ \u00A0\u2009]\d{3}(?!\d))*(?:[.,]\d+)*/g;

/**
 * Classify the digit string (sign already stripped) into one or two readings.
 * Returns null for shapes that are not a number at all (version strings like
 * "3.2.4", malformed grouping); the whole token is then skipped, never split.
 */
function classifyNumber(digits: string): NumberReading[] | null {
  const spaced = digits.split(/[ \u00A0\u2009]/);
  let rest = digits;
  let grouped = false;
  if (spaced.length > 1) {
    if (spaced[0]!.length > 3) return null;
    grouped = true;
    rest = spaced.join('');
  }
  const commas = (rest.match(/,/g) ?? []).length;
  const dots = (rest.match(/\./g) ?? []).length;
  if (commas === 0 && dots === 0) return [{ value: Number(rest), decimals: 0 }];
  if (grouped) {
    // Space grouping fixed the thousands style, so one trailing separator
    // group is a decimal part regardless of its length ("1 200,500").
    const m = /^(\d+)[.,](\d+)$/.exec(rest);
    if (!m) return null;
    return [{ value: Number(`${m[1]}.${m[2]}`), decimals: m[2]!.length }];
  }
  if (commas > 0 && dots > 0) {
    if (/^\d{1,3}(?:,\d{3})+\.\d+$/.test(rest)) {
      const frac = rest.slice(rest.indexOf('.') + 1);
      return [{ value: Number(rest.replace(/,/g, '')), decimals: frac.length }];
    }
    if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(rest)) {
      const frac = rest.slice(rest.indexOf(',') + 1);
      return [{ value: Number(rest.replace(/\./g, '').replace(',', '.')), decimals: frac.length }];
    }
    return null;
  }
  const sep = commas > 0 ? ',' : '.';
  const count = commas > 0 ? commas : dots;
  const parts = rest.split(sep);
  if (count === 1) {
    const [int, frac] = parts as [string, string];
    if (frac.length === 3 && int.length <= 3) {
      // The ambiguous shape: "1,200" (en 1200 / hr 1.2) and "1.200" (en 1.2
      // / hr 1200). The ENGLISH reading is primary; the mirror is carried so
      // a comparison can refuse to decide when the readings diverge.
      const joined: NumberReading = { value: Number(int + frac), decimals: 0 };
      const decimal: NumberReading = { value: Number(`${int}.${frac}`), decimals: 3 };
      return sep === ',' ? [joined, decimal] : [decimal, joined];
    }
    return [{ value: Number(`${int}.${frac}`), decimals: frac.length }];
  }
  if (parts.every((p, k) => (k === 0 ? p.length >= 1 && p.length <= 3 : p.length === 3))) {
    return [{ value: Number(parts.join('')), decimals: 0 }];
  }
  return null;
}

function scanNumbers(text: string): ScannedNumber[] {
  const out: ScannedNumber[] = [];
  NUMBER_RE.lastIndex = 0;
  for (let m = NUMBER_RE.exec(text); m !== null; m = NUMBER_RE.exec(text)) {
    const raw = m[0];
    const negative = raw.startsWith('-');
    const readings = classifyNumber(negative ? raw.slice(1) : raw);
    if (!readings) continue;
    out.push({
      index: m.index,
      raw,
      readings: negative ? readings.map((r) => ({ ...r, value: -r.value })) : readings,
    });
  }
  return out;
}

interface UnitMatch {
  def: UnitDef;
  end: number;
}

/** A unit directly after `pos` (up to 3 spaces away), delimited on its far side. */
function matchUnitAfter(text: string, pos: number): UnitMatch | null {
  let p = pos;
  let spaces = 0;
  while (p < text.length && (text[p] === ' ' || text[p] === '\u00A0' || text[p] === '\t')) {
    p += 1;
    spaces += 1;
  }
  if (spaces > 3) return null;
  for (const token of SORTED_UNIT_TOKENS) {
    if (!text.startsWith(token, p)) continue;
    const def = UNIT_TOKENS.get(token)!;
    if (def.abutOnly && spaces > 0) continue;
    const after = text[p + token.length];
    if (after !== undefined && /[\p{L}\p{N}]/u.test(after)) continue;
    return { def, end: p + token.length };
  }
  return null;
}

/** A currency symbol directly before the number ("€ 40,000"). */
function matchCurrencyBefore(text: string, pos: number): { def: UnitDef; index: number } | null {
  let p = pos - 1;
  let spaces = 0;
  while (p >= 0 && (text[p] === ' ' || text[p] === '\u00A0')) {
    p -= 1;
    spaces += 1;
  }
  if (spaces > 1 || p < 0) return null;
  const ch = text[p];
  if (ch !== '€' && ch !== '$' && ch !== '£') return null;
  const before = text[p - 1];
  if (before !== undefined && /[\p{L}\p{N}]/u.test(before)) return null;
  return { def: UNIT_TOKENS.get(ch)!, index: p };
}

/** The last `tokens` whitespace-separated words before `start`, lowercased. */
function windowBefore(text: string, start: number, tokens: number): string {
  const before = text.slice(Math.max(0, start - 60), start);
  const parts = before.split(/\s+/).filter((t) => t.length > 0);
  return parts.slice(-tokens).join(' ').toLowerCase();
}

const MIN_MARK =
  /(?:\bat least\b|\bno less than\b|\bminimum\b|\bmin\.|≥|>=|\bnajmanje\b|\bminimalno\b|\bbarem\b)/;
const MAX_MARK =
  /(?:\bup to\b|\bat most\b|\bmaximum\b|\bmax\.|≤|<=|\bnajviše\b|\bnajvise\b|\bmaksimalno\b)/;
const APPROX_MARK =
  /(?:~|≈|\bapprox\b|\bapproximately\b|\babout\b|\baround\b|\boko\b|\bcca\b|\bpribližno\b|\bpriblizno\b|\botprilike\b)/;

const TOLERANCE_CONNECTOR =
  /^[ \u00A0]*(?:±|\+\/-|plus[ \u00A0-]or[ \u00A0-]minus|plus[ \u00A0-]ili[ \u00A0-]minus|plus[ \u00A0-]?minus)[ \u00A0]*$/i;
const RANGE_CONNECTOR = /^[ \u00A0]*(?:[-–—]|\b(to|do|i|and)\b)[ \u00A0]*$/;
const BETWEEN_LEAD = /\b(?:between|između|izmedu)\b/;

/** One reading of a whole construct: base value, stated value, coarsest decimals. */
interface ConstructReading {
  value: QuantityValue;
  stated: QuantityValue;
  decimals: number;
}

interface Construct {
  start: number;
  end: number;
  /** Where the FIRST number starts: marker windows anchor here, not at a lead symbol. */
  anchorIndex: number;
  def: UnitDef;
  primary: ConstructReading;
  alt: ConstructReading | null;
}

type NumberPair = [NumberReading, NumberReading | null];

/** Primary pair plus, when any component is ambiguous, the alternate pair. */
function readingPairs(n1: ScannedNumber, n2: ScannedNumber | null): NumberPair[] {
  const primary: NumberPair = [n1.readings[0]!, n2 ? n2.readings[0]! : null];
  const hasAlt = n1.readings.length > 1 || (n2 !== null && n2.readings.length > 1);
  if (!hasAlt) return [primary];
  const alt: NumberPair = [
    n1.readings[1] ?? n1.readings[0]!,
    n2 ? (n2.readings[1] ?? n2.readings[0]!) : null,
  ];
  return [primary, alt];
}

function buildTolerance(
  n1: ScannedNumber,
  unit1: UnitMatch | null,
  n2: ScannedNumber,
  unit2: UnitMatch | null,
): Construct | null {
  if (!unit1 && !unit2) return null;
  const percent =
    unit2 !== null &&
    unit2.def.dimension === 'percentage' &&
    unit1 !== null &&
    unit1.def.dimension !== 'percentage';
  if (unit1 && unit2 && !percent && unit1.def.dimension !== unit2.def.dimension) return null;
  const anchorDef = unit1 ? unit1.def : unit2!.def;
  const spreadDef = percent ? anchorDef : unit2 ? unit2.def : unit1!.def;
  const make = ([a, t]: NumberPair): ConstructReading => {
    // Absolute: the number scanner may have claimed the connector's '-' as a
    // sign ("3.2+/-0.1mm" scans as '3.2', '+/', '-0.1').
    const tv = Math.abs(t!.value);
    const baseCenter = toBase(anchorDef, a.value);
    const statedSpread = percent
      ? (Math.abs(a.value) * (tv * unit2!.def.factor)) / 100
      : tv * (spreadDef.factor / anchorDef.factor);
    const spreadBase = statedSpread * anchorDef.factor;
    return {
      value: { kind: 'range', low: baseCenter - spreadBase, high: baseCenter + spreadBase },
      stated: { kind: 'range', low: a.value - statedSpread, high: a.value + statedSpread },
      decimals: percent ? a.decimals : Math.min(a.decimals, t!.decimals),
    };
  };
  const pairs = readingPairs(n1, n2);
  const end = unit2 ? unit2.end : n2.index + n2.raw.length;
  return {
    start: n1.index,
    end,
    anchorIndex: n1.index,
    def: anchorDef,
    primary: make(pairs[0]!),
    alt: pairs.length > 1 ? make(pairs[1]!) : null,
  };
}

function buildRange(
  n1: ScannedNumber,
  unit1: UnitMatch | null,
  n2: ScannedNumber,
  unit2: UnitMatch,
): Construct {
  const u1def = unit1?.def ?? null;
  const u2def = unit2.def;
  const make = ([a, b]: NumberPair): ConstructReading => {
    const baseA = toBase(u1def ?? u2def, a.value);
    const baseB = toBase(u2def, b!.value);
    const statedA = u1def ? (a.value * u1def.factor) / u2def.factor : a.value;
    const statedB = b!.value;
    return {
      value: { kind: 'range', low: Math.min(baseA, baseB), high: Math.max(baseA, baseB) },
      stated: { kind: 'range', low: Math.min(statedA, statedB), high: Math.max(statedA, statedB) },
      decimals: Math.min(a.decimals, b!.decimals),
    };
  };
  const pairs = readingPairs(n1, n2);
  return {
    start: n1.index,
    end: unit2.end,
    anchorIndex: n1.index,
    def: u2def,
    primary: make(pairs[0]!),
    alt: pairs.length > 1 ? make(pairs[1]!) : null,
  };
}

function buildSingle(text: string, n1: ScannedNumber, unit: UnitMatch, start: number): Construct {
  const boundWindow = windowBefore(text, n1.index, 3);
  const kind: 'point' | 'min' | 'max' = MIN_MARK.test(boundWindow)
    ? 'min'
    : MAX_MARK.test(boundWindow)
      ? 'max'
      : 'point';
  const make = ([a]: NumberPair): ConstructReading => ({
    value: { kind, value: toBase(unit.def, a.value) },
    stated: { kind, value: a.value },
    decimals: a.decimals,
  });
  const pairs = readingPairs(n1, null);
  return {
    start,
    end: unit.end,
    anchorIndex: n1.index,
    def: unit.def,
    primary: make(pairs[0]!),
    alt: pairs.length > 1 ? make(pairs[1]!) : null,
  };
}

function finalize(text: string, c: Construct): ParsedQuantity {
  const approximate = APPROX_MARK.test(windowBefore(text, c.anchorIndex, 2));
  return {
    value: c.primary.value,
    dimension: c.def.dimension,
    unit: c.def.symbol,
    approximate,
    statedDecimals: c.primary.decimals,
    factor: c.def.factor,
    raw: text.slice(c.start, c.end),
    index: c.start,
    stated: c.primary.stated,
    ...(c.alt
      ? {
          ambiguous: {
            value: c.alt.value,
            stated: c.alt.stated,
            statedDecimals: c.alt.decimals,
          },
        }
      : {}),
  };
}

function buildConstruct(
  text: string,
  nums: ScannedNumber[],
  i: number,
): { q: ParsedQuantity; next: number } | null {
  const n1 = nums[i]!;
  const end1 = n1.index + n1.raw.length;
  const unit1 = matchUnitAfter(text, end1);
  const n2 = nums[i + 1] ?? null;
  const afterFirst = unit1 ? unit1.end : end1;
  const between = n2 ? text.slice(afterFirst, n2.index) : '';

  const toleranceHit =
    n2 !== null &&
    (TOLERANCE_CONNECTOR.test(between) ||
      // "+/-" with the trailing '-' scanned as the sign of the second number.
      (/^[ \u00A0]*\+\/$/.test(between) && n2.raw.startsWith('-')));
  if (n2 && toleranceHit) {
    const unit2 = matchUnitAfter(text, n2.index + n2.raw.length);
    const built = buildTolerance(n1, unit1, n2, unit2);
    if (built) return { q: finalize(text, built), next: i + 2 };
  }

  const rangeMatch = n2 ? RANGE_CONNECTOR.exec(between) : null;
  if (n2 && rangeMatch) {
    const word = rangeMatch[1];
    const needsLead = word === 'i' || word === 'and';
    const leadOk = !needsLead || BETWEEN_LEAD.test(windowBefore(text, n1.index, 3));
    const unit2 = matchUnitAfter(text, n2.index + n2.raw.length);
    if (leadOk && unit2 && (!unit1 || unit1.def.dimension === unit2.def.dimension)) {
      return { q: finalize(text, buildRange(n1, unit1, n2, unit2)), next: i + 2 };
    }
  }

  if (unit1) return { q: finalize(text, buildSingle(text, n1, unit1, n1.index)), next: i + 1 };
  const lead = matchCurrencyBefore(text, n1.index);
  if (lead) {
    const unit: UnitMatch = { def: lead.def, end: end1 };
    return { q: finalize(text, buildSingle(text, n1, unit, lead.index)), next: i + 1 };
  }
  return null;
}

/** Every quantity in `text`, left to right; constructs never overlap. */
export function parseQuantities(text: string): ParsedQuantity[] {
  const nums = scanNumbers(text);
  const out: ParsedQuantity[] = [];
  let i = 0;
  while (i < nums.length) {
    const built = buildConstruct(text, nums, i);
    if (built) {
      out.push(built.q);
      i = built.next;
    } else {
      i += 1;
    }
  }
  return out;
}

type PairVerdict = 'agreement' | 'conflict' | 'bounds_only';

function representative(v: QuantityValue): number {
  return v.kind === 'range' ? (v.low + v.high) / 2 : v.value;
}

/** Ordered half of the kind dispatch; the caller retries with the sides swapped. */
function decideOrdered(a: QuantityValue, b: QuantityValue, tol: number): PairVerdict | null {
  if (a.kind === 'point') {
    if (b.kind === 'point') return Math.abs(a.value - b.value) <= tol ? 'agreement' : 'conflict';
    if (b.kind === 'range') {
      return b.low - tol <= a.value && a.value <= b.high + tol ? 'agreement' : 'conflict';
    }
    if (b.kind === 'min') return a.value >= b.value - tol ? 'agreement' : 'conflict';
    return a.value <= b.value + tol ? 'agreement' : 'conflict';
  }
  if (a.kind === 'range') {
    if (b.kind === 'range') {
      return a.low <= b.high + tol && b.low <= a.high + tol ? 'agreement' : 'conflict';
    }
    if (b.kind === 'min') return a.high >= b.value - tol ? 'agreement' : 'conflict';
    if (b.kind === 'max') return a.low <= b.value + tol ? 'agreement' : 'conflict';
    return null;
  }
  if (a.kind === 'min') {
    // A tightened same-direction bound is supersession territory, not a
    // contradiction this module can call: unequal min/min (or max/max) is
    // the dedicated 'bounds_only' undecided outcome.
    if (b.kind === 'min') return Math.abs(a.value - b.value) <= tol ? 'agreement' : 'bounds_only';
    if (b.kind === 'max') return a.value <= b.value + tol ? 'agreement' : 'conflict';
    return null;
  }
  if (b.kind === 'max') return Math.abs(a.value - b.value) <= tol ? 'agreement' : 'bounds_only';
  return null;
}

function decideValues(a: QuantityValue, b: QuantityValue, tol: number): PairVerdict {
  return decideOrdered(a, b, tol) ?? decideOrdered(b, a, tol)!;
}

interface QuantityReading {
  value: QuantityValue;
  decimals: number;
}

function decidePair(
  a: ParsedQuantity,
  ra: QuantityReading,
  b: ParsedQuantity,
  rb: QuantityReading,
): PairVerdict {
  let tol = Math.max(0.5 * 10 ** -ra.decimals * a.factor, 0.5 * 10 ** -rb.decimals * b.factor);
  if (a.approximate || b.approximate) {
    tol = Math.max(
      tol,
      0.05 * Math.max(Math.abs(representative(ra.value)), Math.abs(representative(rb.value))),
    );
  }
  return decideValues(ra.value, rb.value, tol);
}

function readingsOf(q: ParsedQuantity): QuantityReading[] {
  const out: QuantityReading[] = [{ value: q.value, decimals: q.statedDecimals }];
  if (q.ambiguous) out.push({ value: q.ambiguous.value, decimals: q.ambiguous.statedDecimals });
  return out;
}

/**
 * An ambiguous number decides only when every reading combination decides
 * identically; otherwise the pair is 'ambiguous' and the whole comparison
 * refuses with 'ambiguous_number'.
 */
function compareReadings(a: ParsedQuantity, b: ParsedQuantity): PairVerdict | 'ambiguous' {
  const verdicts = new Set<PairVerdict>();
  for (const ra of readingsOf(a)) {
    for (const rb of readingsOf(b)) {
      verdicts.add(decidePair(a, ra, b, rb));
    }
  }
  return verdicts.size === 1 ? [...verdicts][0]! : 'ambiguous';
}

/**
 * Marker words removed from the residual before the Jaccard slot check.
 * The text is folded first (lowercase, NFD, marks dropped), so the Croatian
 * entries are in their folded spelling; đ does not decompose, hence both
 * 'izmedu' and 'između'.
 */
const STRIP_WORDS_RE =
  /\b(?:at least|no less than|at most|up to|no more than|minimum|maximum|min|max|najmanje|minimalno|barem|najvise|maksimalno|approx|approximately|about|around|oko|cca|priblizno|otprilike|between|izmedu|između|from|od|do|to|and|i)\b/g;

/** Fold + strip: the tokens of `text` with every quantity and marker removed. */
function residualTokens(text: string, quantities: ParsedQuantity[]): Set<string> {
  let masked = '';
  let cursor = 0;
  for (const q of [...quantities].sort((x, y) => x.index - y.index)) {
    if (q.index < cursor) continue;
    masked += `${text.slice(cursor, q.index)} `;
    cursor = q.index + q.raw.length;
  }
  masked += text.slice(cursor);
  let s = masked
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
  s = s.replace(STRIP_WORDS_RE, ' ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return new Set(s.split(' ').filter((t) => t.length > 0));
}

/**
 * The slot check: with the numbers gone, do the two claims still talk about
 * the same thing? Returns the residual Jaccard, or null when both residuals
 * are empty (the claims were essentially just quantities — a pass). The
 * caller applies an ASYMMETRIC bar: agreement needs 0.5, a CONFLICT needs
 * 0.7, because "current draw at full load" vs "current draw in standby"
 * shares exactly half its tokens and is precisely the qualified-values shape
 * a deterministic conflict must never conclude on.
 */
function residualJaccard(
  contentA: string,
  qa: ParsedQuantity[],
  contentB: string,
  qb: ParsedQuantity[],
): number | null {
  const ta = residualTokens(contentA, qa);
  const tb = residualTokens(contentB, qb);
  if (ta.size === 0 && tb.size === 0) return null;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? null : intersection / union;
}

const SLOT_BAR_AGREEMENT = 0.5;
const SLOT_BAR_CONFLICT = 0.7;

function groupByDimension(quantities: ParsedQuantity[]): Map<Dimension, ParsedQuantity[]> {
  const map = new Map<Dimension, ParsedQuantity[]>();
  for (const q of quantities) {
    const list = map.get(q.dimension);
    if (list) list.push(q);
    else map.set(q.dimension, [q]);
  }
  return map;
}

/** Deterministic numeric comparison of two claims; see the module comment. */
export function compareQuantities(contentA: string, contentB: string): QuantityDecision {
  const qa = parseQuantities(contentA);
  const qb = parseQuantities(contentB);
  if (qa.length === 0 && qb.length === 0) return { decision: 'undecided', reason: 'no_quantities' };
  if (qa.length === 0 || qb.length === 0) return { decision: 'undecided', reason: 'one_sided' };
  const byDimA = groupByDimension(qa);
  const byDimB = groupByDimension(qb);
  const shared = [...byDimA.keys()].filter((d) => byDimB.has(d));
  if (shared.length === 0) return { decision: 'undecided', reason: 'no_shared_dimension' };
  const usable = shared.filter((d) => byDimA.get(d)!.length === 1 && byDimB.get(d)!.length === 1);
  if (usable.length === 0) return { decision: 'undecided', reason: 'multiple_per_dimension' };
  const outcomes = usable.map((dimension) => {
    const a = byDimA.get(dimension)![0]!;
    const b = byDimB.get(dimension)![0]!;
    return { dimension, a, b, verdict: compareReadings(a, b) };
  });
  if (outcomes.some((o) => o.verdict === 'ambiguous')) {
    return { decision: 'undecided', reason: 'ambiguous_number' };
  }
  const jaccard = residualJaccard(contentA, qa, contentB, qb);
  if (jaccard !== null && jaccard < SLOT_BAR_AGREEMENT) {
    return { decision: 'undecided', reason: 'different_slot' };
  }
  const conflict = outcomes.find((o) => o.verdict === 'conflict');
  if (conflict) {
    if (jaccard !== null && jaccard < SLOT_BAR_CONFLICT) {
      return { decision: 'undecided', reason: 'different_slot' };
    }
    return {
      decision: 'conflict',
      dimension: conflict.dimension,
      aRaw: conflict.a.raw,
      bRaw: conflict.b.raw,
    };
  }
  const agreement = outcomes.find((o) => o.verdict === 'agreement');
  if (agreement) {
    return {
      decision: 'agreement',
      dimension: agreement.dimension,
      aRaw: agreement.a.raw,
      bRaw: agreement.b.raw,
    };
  }
  return { decision: 'undecided', reason: 'bounds_only' };
}

/**
 * Up to 6 significant digits, no trailing zeros, plain decimal notation for
 * absolute values between 1e-6 and 1e9.
 */
function fmt(n: number): string {
  const rounded = Number(n.toPrecision(6));
  const abs = Math.abs(rounded);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e9)) return String(rounded);
  let s = String(rounded);
  if (s.includes('e') || s.includes('E')) {
    const digits = Math.max(0, 6 - Math.floor(Math.log10(abs)) - 1);
    s = rounded.toFixed(Math.min(20, digits)).replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

function renderValue(v: QuantityValue, symbol: string): string {
  return v.kind === 'range'
    ? `${fmt(v.low)} to ${fmt(v.high)} ${symbol}`
    : `${fmt(v.value)} ${symbol}`;
}

/** One line per parsed quantity, for the judge prompt: "3.2 mm = 0.0032 m (length)". */
export function describeQuantities(text: string): string[] {
  return parseQuantities(text).map((q) => {
    const baseSymbol = BASE_SYMBOL[q.dimension];
    const prefix = q.value.kind === 'min' ? 'at least ' : q.value.kind === 'max' ? 'up to ' : '';
    const conversion =
      q.factor === 1 && q.unit === baseSymbol ? '' : ` = ${renderValue(q.value, baseSymbol)}`;
    const kindNote =
      q.value.kind === 'range'
        ? ', range'
        : q.value.kind === 'min'
          ? ', minimum'
          : q.value.kind === 'max'
            ? ', maximum'
            : '';
    const approxNote = q.approximate ? ', approximate' : '';
    return `${prefix}${renderValue(q.stated, q.unit)}${conversion} (${q.dimension}${kindNote}${approxNote})`;
  });
}
