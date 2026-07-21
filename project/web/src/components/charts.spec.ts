import { describe, expect, it } from 'vitest';
import type { DailySeries } from '@cogeto/shared';
import {
  barHeights,
  donutArcs,
  niceMax,
  seriesSummary,
  seriesTotal,
  sparklinePoints,
} from './charts';

describe('charts geometry', () => {
  it('niceMax is honest: never below the peak, sensible rounding', () => {
    expect(niceMax([])).toBe(1);
    expect(niceMax([0, 0])).toBe(1);
    expect(niceMax([3])).toBe(5);
    expect(niceMax([7])).toBe(10);
    expect(niceMax([12])).toBe(20);
    expect(niceMax([48])).toBe(50);
    expect(niceMax([120])).toBeGreaterThanOrEqual(120);
  });

  it('barHeights stay within the box and honor an all-zero series', () => {
    const heights = barHeights([0, 2, 5, 10], 100);
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(100);
    }
    // Tallest bar (10) reaches the honest max (10) → full height.
    expect(heights[3]).toBe(100);
    expect(barHeights([0, 0, 0], 100)).toEqual([0, 0, 0]);
  });

  it('sparklinePoints yields one point per value, inside the box', () => {
    const pts = sparklinePoints([1, 4, 2, 8], 120, 40).split(' ');
    expect(pts).toHaveLength(4);
    for (const p of pts) {
      const [x, y] = p.split(',').map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(120);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(40);
    }
    // Empty series draws a flat baseline (two points), never a spurious jump.
    expect(sparklinePoints([], 120, 40).split(' ')).toHaveLength(2);
  });

  it('donutArcs partition the ring: fractions sum to 1, offsets accumulate', () => {
    const arcs = donutArcs(
      [
        { key: 'active', value: 6 },
        { key: 'uncertain', value: 3 },
        { key: 'outdated', value: 1 },
      ],
      100,
    );
    expect(arcs).toHaveLength(3);
    const fractionSum = arcs.reduce((s, a) => s + a.fraction, 0);
    expect(fractionSum).toBeCloseTo(1, 5);
    // Offsets march backwards as arcs are consumed (0, -60, -90 for 6/3/1 of 100).
    expect(arcs[0]!.dashOffset).toBe(-0);
    expect(arcs[1]!.dashOffset).toBe(-60);
    expect(arcs[2]!.dashOffset).toBe(-90);
    // Zero total → no arcs (caller draws an empty ring).
    expect(donutArcs([{ key: 'x', value: 0 }], 100)).toEqual([]);
  });

  it('seriesSummary is a faithful text equivalent of the chart', () => {
    const series: DailySeries = {
      days: 30,
      keys: ['notes', 'email', 'files'],
      series: [
        { date: '2026-07-19', counts: { notes: 2, email: 0, files: 1 } },
        { date: '2026-07-20', counts: { notes: 1, email: 3, files: 0 } },
      ],
    };
    const summary = seriesSummary(series);
    expect(summary).toContain('3 notes');
    expect(summary).toContain('3 email');
    expect(summary).toContain('1 files');
    expect(seriesTotal(series, 'notes')).toBe(3);
    expect(seriesSummary({ days: 30, keys: ['notes'], series: [] })).toContain('No activity');
  });
});
