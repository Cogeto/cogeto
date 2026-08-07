import { describe, expect, it } from 'vitest';

import {
  compareQuantities,
  describeQuantities,
  parseQuantities,
  type ParsedQuantity,
} from './quantity';

function only(text: string): ParsedQuantity {
  const quantities = parseQuantities(text);
  expect(quantities).toHaveLength(1);
  return quantities[0]!;
}

function pointValue(q: ParsedQuantity): number {
  if (q.value.kind !== 'point' && q.value.kind !== 'min' && q.value.kind !== 'max') {
    throw new Error(`expected a single-valued kind, got ${q.value.kind}`);
  }
  return q.value.value;
}

function rangeValue(q: ParsedQuantity): [number, number] {
  if (q.value.kind !== 'range') throw new Error(`expected range, got ${q.value.kind}`);
  return [q.value.low, q.value.high];
}

/** Relative closeness, safe for both 0.0032 and 512e9. */
function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-9 + 1e-12);
}

describe('parseQuantities: plain values', () => {
  it('parses a plain length in millimetres', () => {
    const q = only('3.2 mm');
    expect(q.dimension).toBe('length');
    expect(q.unit).toBe('mm');
    expect(q.factor).toBe(0.001);
    expect(q.statedDecimals).toBe(1);
    expect(q.approximate).toBe(false);
    expect(q.raw).toBe('3.2 mm');
    expect(q.index).toBe(0);
    expectClose(pointValue(q), 0.0032);
  });

  it('parses a unit abutting the number', () => {
    const q = only('3.2mm');
    expect(q.raw).toBe('3.2mm');
    expectClose(pointValue(q), 0.0032);
  });

  it('parses a Croatian decimal comma', () => {
    const q = only('Debljina je 3,2 mm');
    expect(q.raw).toBe('3,2 mm');
    expect(q.statedDecimals).toBe(1);
    expectClose(pointValue(q), 0.0032);
  });

  it('parses space-grouped thousands', () => {
    const q = only('1 200 kg');
    expect(q.dimension).toBe('mass');
    expect(q.statedDecimals).toBe(0);
    expect(q.ambiguous).toBeUndefined();
    expectClose(pointValue(q), 1200);
  });

  it('parses English thousands plus decimal unambiguously', () => {
    const q = only('price is 1,200.50 USD');
    expect(q.dimension).toBe('currency_usd');
    expect(q.statedDecimals).toBe(2);
    expect(q.ambiguous).toBeUndefined();
    expectClose(pointValue(q), 1200.5);
  });

  it('parses Croatian thousands plus decimal unambiguously', () => {
    const q = only('1.200,50 EUR');
    expect(q.dimension).toBe('currency_eur');
    expect(q.ambiguous).toBeUndefined();
    expectClose(pointValue(q), 1200.5);
  });

  it('marks a single comma before three digits as ambiguous, English reading first', () => {
    const q = only('1,200 kg');
    expectClose(pointValue(q), 1200);
    expect(q.statedDecimals).toBe(0);
    expect(q.ambiguous).toBeDefined();
    expect(q.ambiguous!.value).toEqual({ kind: 'point', value: 1.2 });
    expect(q.ambiguous!.statedDecimals).toBe(3);
  });

  it('marks a single dot before three digits as the mirrored ambiguity', () => {
    const q = only('1.200 m');
    expectClose(pointValue(q), 1.2);
    expect(q.statedDecimals).toBe(3);
    expect(q.ambiguous).toBeDefined();
    expect(q.ambiguous!.value).toEqual({ kind: 'point', value: 1200 });
  });

  it('reads a comma before one or two digits as an unambiguous decimal', () => {
    const q = only('3,25 m');
    expect(q.ambiguous).toBeUndefined();
    expectClose(pointValue(q), 3.25);
  });

  it('parses a negative temperature', () => {
    const q = only('the freezer runs at -5 °C');
    expect(q.dimension).toBe('temperature');
    expect(q.unit).toBe('°C');
    expectClose(pointValue(q), -5);
  });

  it('converts Fahrenheit to Celsius', () => {
    expectClose(pointValue(only('212 °F')), 100);
  });

  it('parses kelvin only when directly attached to the number', () => {
    expectClose(pointValue(only('300K')), 26.85);
    expect(parseQuantities('300 K')).toHaveLength(0);
  });

  it('parses a leading currency symbol', () => {
    const q = only('€ 40,000');
    expect(q.unit).toBe('EUR');
    expect(q.raw).toBe('€ 40,000');
    expect(q.index).toBe(0);
    expectClose(pointValue(q), 40000);
    expect(q.ambiguous).toBeDefined();
  });

  it('parses a Croatian currency word after the number', () => {
    const q = only('40 eura');
    expect(q.unit).toBe('EUR');
    expectClose(pointValue(q), 40);
  });

  it('is case-sensitive where collision matters: mW vs MW', () => {
    expectClose(pointValue(only('5 mW')), 0.005);
    expectClose(pointValue(only('5 MW')), 5e6);
  });

  it('is case-sensitive where collision matters: mm vs m', () => {
    const q = only('3 m');
    expect(q.unit).toBe('m');
    expect(q.factor).toBe(1);
    expectClose(pointValue(q), 3);
  });

  it('does not parse bare numbers without a unit', () => {
    expect(parseQuantities('model 3000')).toHaveLength(0);
    expect(parseQuantities('Windows 11')).toHaveLength(0);
  });

  it('parses counts only with kom, komada or pcs', () => {
    expect(parseQuantities('3 people')).toHaveLength(0);
    expect(only('3 kom').dimension).toBe('count');
    expect(only('5 pcs').dimension).toBe('count');
    expect(only('10 komada').unit).toBe('kom');
  });

  it('rejects version strings outright', () => {
    expect(parseQuantities('verzija 3.2.4 je stabilna')).toHaveLength(0);
  });

  it('parses data sizes, decimal and binary', () => {
    expectClose(pointValue(only('512 GB')), 512e9);
    expectClose(pointValue(only('512 KiB')), 524288);
  });

  it('parses time, pressure and frequency', () => {
    expectClose(pointValue(only('10 min')), 600);
    expectClose(pointValue(only('2 bar')), 200000);
    expectClose(pointValue(only('2.4 GHz')), 2.4e9);
  });

  it('parses permille into the percent base', () => {
    const q = only('5 ‰');
    expect(q.dimension).toBe('percentage');
    expectClose(pointValue(q), 0.5);
  });

  it('parses cubic metres as litres', () => {
    expectClose(pointValue(only('2 m³')), 2000);
    expectClose(pointValue(only('2 m3')), 2000);
  });
});

describe('parseQuantities: ranges, tolerances, bounds, approximation', () => {
  const expectMmRange = (text: string): void => {
    const q = only(text);
    const [low, high] = rangeValue(q);
    expectClose(low, 0.0032);
    expectClose(high, 0.0034);
  };

  it('parses a hyphen range', () => {
    expectMmRange('3.2-3.4 mm');
  });

  it('parses an en dash range with spaces', () => {
    expectMmRange('3.2 – 3.4 mm');
  });

  it('parses a "to" range', () => {
    expectMmRange('3.2 to 3.4 mm');
  });

  it('parses a "from X to Y" range as one quantity', () => {
    expectMmRange('from 3.2 to 3.4 mm');
  });

  it('parses a "between X and Y" range', () => {
    expectMmRange('between 3.2 and 3.4 mm');
  });

  it('parses the Croatian "od X do Y" range', () => {
    expectMmRange('od 3,2 do 3,4 mm');
  });

  it('parses the Croatian "između X i Y" range', () => {
    expectMmRange('između 3,2 i 3,4 mm');
  });

  it('does not merge and-joined values without a between lead', () => {
    expect(parseQuantities('3.2 mm and 4.5 mm')).toHaveLength(2);
  });

  it('converts each side of a mixed-unit range', () => {
    const [low, high] = rangeValue(only('od 1 m do 120 cm'));
    expectClose(low, 1);
    expectClose(high, 1.2);
  });

  it('parses a plus-minus tolerance into an inclusive range', () => {
    const [low, high] = rangeValue(only('3.2 ± 0.1 mm'));
    expectClose(low, 0.0031);
    expectClose(high, 0.0033);
  });

  it('parses the compact "+/-" tolerance form', () => {
    const [low, high] = rangeValue(only('3.2+/-0.1mm'));
    expectClose(low, 0.0031);
    expectClose(high, 0.0033);
  });

  it('parses a percent tolerance as percent of the value', () => {
    const q = only('230 V ±5%');
    expect(q.dimension).toBe('voltage');
    expect(q.unit).toBe('V');
    const [low, high] = rangeValue(q);
    expectClose(low, 218.5);
    expectClose(high, 241.5);
  });

  it('parses minimum bounds in both languages', () => {
    for (const text of ['at least 10 kW', 'min. 10 kW', 'najmanje 10 kW', '≥ 10 kW']) {
      const q = only(text);
      expect(q.value.kind).toBe('min');
      expectClose(pointValue(q), 10000);
    }
  });

  it('keeps the bound marker out of the raw match', () => {
    expect(only('at least 10 kW').raw).toBe('10 kW');
  });

  it('parses maximum bounds in both languages', () => {
    for (const text of ['up to 5 mm', 'at most 5 mm', 'najviše 5 mm', '≤ 5 mm']) {
      const q = only(text);
      expect(q.value.kind).toBe('max');
      expectClose(pointValue(q), 0.005);
    }
  });

  it('marks approximation in both languages', () => {
    for (const text of ['~3.2 mm', 'approximately 3.2 mm', 'oko 3,2 mm', 'cca 3,2 mm']) {
      expect(only(text).approximate).toBe(true);
    }
    expect(only('3.2 mm').approximate).toBe(false);
  });

  it('parses the approximate ambiguous Croatian amount', () => {
    const q = only('oko 40.000 EUR');
    expect(q.approximate).toBe(true);
    expect(q.unit).toBe('EUR');
    expectClose(pointValue(q), 40);
    expect(q.ambiguous!.value).toEqual({ kind: 'point', value: 40000 });
  });
});

describe('compareQuantities', () => {
  it('conflicts on the same slot with differing values', () => {
    const d = compareQuantities('The wall thickness is 3.2 mm', 'The wall thickness is 3.4 mm');
    expect(d).toEqual({
      decision: 'conflict',
      dimension: 'length',
      aRaw: '3.2 mm',
      bRaw: '3.4 mm',
    });
  });

  it('agrees on the same value in different units', () => {
    expect(compareQuantities('3.2 mm', '0.32 cm').decision).toBe('agreement');
  });

  it('treats a precision-only difference as agreement', () => {
    expect(compareQuantities('3.2 mm', '3.20 mm').decision).toBe('agreement');
    expect(compareQuantities('3.2 mm', '3.24 mm').decision).toBe('agreement');
  });

  it('conflicts on a genuine difference at the stated precision', () => {
    expect(compareQuantities('3.2 mm', '3.3 mm').decision).toBe('conflict');
  });

  it('agrees on overlapping ranges and conflicts on disjoint ones', () => {
    expect(compareQuantities('3.2-3.6 mm', '3.5 to 3.8 mm').decision).toBe('agreement');
    expect(compareQuantities('3.2-3.4 mm', '3.6 to 3.8 mm').decision).toBe('conflict');
  });

  it('checks a point against a tolerance band', () => {
    expect(compareQuantities('3.2 ± 0.1 mm', '3.15 mm').decision).toBe('agreement');
    expect(compareQuantities('3.2 ± 0.1 mm', '3.45 mm').decision).toBe('conflict');
  });

  it('refuses to compare quantities from different slots', () => {
    const d = compareQuantities('width 3.2 mm', 'operating temperature limit rating 3.4 mm');
    expect(d).toEqual({ decision: 'undecided', reason: 'different_slot' });
  });

  it('skips a dimension carrying more than one quantity per side', () => {
    const d = compareQuantities('flanges of 3.2 mm and 4.5 mm', 'flange of 3.4 mm');
    expect(d).toEqual({ decision: 'undecided', reason: 'multiple_per_dimension' });
  });

  it('reports no shared dimension', () => {
    const d = compareQuantities('mass is 10 kg', 'voltage is 10 V');
    expect(d).toEqual({ decision: 'undecided', reason: 'no_shared_dimension' });
  });

  it('reports one-sided and no-quantity inputs', () => {
    expect(compareQuantities('the wall is thick', 'the wall is 3.2 mm')).toEqual({
      decision: 'undecided',
      reason: 'one_sided',
    });
    expect(compareQuantities('the wall is thick', 'so it is')).toEqual({
      decision: 'undecided',
      reason: 'no_quantities',
    });
  });

  it('refuses an ambiguous number whose readings disagree', () => {
    const d = compareQuantities('1,200 kg', '1.2 kg');
    expect(d).toEqual({ decision: 'undecided', reason: 'ambiguous_number' });
  });

  it('decides an ambiguous number when both readings decide identically', () => {
    const d = compareQuantities('1,200 kg', '5000 kg');
    expect(d.decision).toBe('conflict');
  });

  it('returns bounds_only for unequal same-direction bounds', () => {
    const d = compareQuantities('at least 10 kW', 'najmanje 12 kW');
    expect(d).toEqual({ decision: 'undecided', reason: 'bounds_only' });
  });

  it('checks a point against a bound', () => {
    expect(compareQuantities('at least 10 kW', '12 kW').decision).toBe('agreement');
    expect(compareQuantities('at least 10 kW', '8 kW').decision).toBe('conflict');
  });

  it('checks a minimum against a maximum for joint satisfiability', () => {
    expect(compareQuantities('at least 5 mm', 'up to 10 mm').decision).toBe('agreement');
    expect(compareQuantities('at least 12 mm', 'up to 10 mm').decision).toBe('conflict');
  });

  it('conflicts on full Croatian sentences', () => {
    const d = compareQuantities('Debljina stijenke je 3,2 mm', 'Debljina stijenke je 3,4 mm');
    expect(d).toEqual({
      decision: 'conflict',
      dimension: 'length',
      aRaw: '3,2 mm',
      bRaw: '3,4 mm',
    });
  });

  it('agrees across temperature scales', () => {
    expect(compareQuantities('212 °F', '100 °C').decision).toBe('agreement');
  });
});

describe('describeQuantities', () => {
  it('describes a converted point value', () => {
    expect(describeQuantities('3.2 mm')).toEqual(['3.2 mm = 0.0032 m (length)']);
  });

  it('omits the conversion clause for a base unit', () => {
    expect(describeQuantities('230 V')).toEqual(['230 V (voltage)']);
  });

  it('describes a tolerance as a range', () => {
    expect(describeQuantities('3.2 ± 0.1 mm')).toEqual([
      '3.1 to 3.3 mm = 0.0031 to 0.0033 m (length, range)',
    ]);
  });

  it('describes a minimum bound', () => {
    expect(describeQuantities('at least 10 kW')).toEqual([
      'at least 10 kW = 10000 W (power, minimum)',
    ]);
  });

  it('notes approximation inside the parens', () => {
    expect(describeQuantities('~3.2 mm')).toEqual(['3.2 mm = 0.0032 m (length, approximate)']);
  });

  it('returns an empty list when nothing parses', () => {
    expect(describeQuantities('no numbers here')).toEqual([]);
  });
});

describe('golden-set regression shapes (V2.3 item 6.1 measurement round)', () => {
  it('worded tolerance in both languages contains the measured value', () => {
    // en-r021 / hr-r020: the ± was written in words and the percent as a word.
    expect(
      compareQuantities(
        'The AD-3 adapter supply voltage is 230 V plus or minus 5 percent.',
        'The AD-3 adapter measured supply voltage was 235 V.',
      ).decision,
    ).toBe('agreement');
    expect(
      compareQuantities(
        'Napon napajanja adaptera AD-3 je 230 V plus-minus 5 posto.',
        'Izmjereni napon napajanja adaptera AD-3 bio je 235 V.',
      ).decision,
    ).toBe('agreement');
  });

  it('condition-qualified values never conclude a conflict (asymmetric slot bar)', () => {
    // en-r023: half the residual tokens agree; that is a qualified pair, not
    // a same-slot conflict the deterministic arm may call.
    const decision = compareQuantities(
      'The M2 sensor current draw is 150 mA at full load.',
      'The M2 sensor current draw is 40 mA in standby.',
    );
    expect(decision.decision).toBe('undecided');
  });
});
