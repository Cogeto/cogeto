import type { DailySeries } from '@cogeto/shared';

/**
 * Small, dependency-free chart geometry (Post-v1 Priority 2). Hand-rolled SVG
 * math instead of a charting library — the frontend takes on no new dependency
 * (a standing rule), and these charts are tiny (sparklines, compact bars, a
 * status donut). Pure functions, unit-tested in charts.spec.ts; the .tsx layer
 * only maps their output to SVG elements. Every chart pairs with a text
 * equivalent (see `seriesSummary`) so meaning never rides on color or shape.
 */

/** An `nice`, honest axis maximum ≥ every value (never a misleading crop). */
export function niceMax(values: number[]): number {
  const peak = Math.max(0, ...values);
  if (peak === 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= peak) return candidate;
  }
  return 10 * magnitude;
}

/** Bar heights (px) for a compact bar chart, honestly scaled to `niceMax`. */
export function barHeights(values: number[], height: number): number[] {
  const max = niceMax(values);
  return values.map((v) => (max === 0 ? 0 : (Math.max(0, v) / max) * height));
}

/**
 * An SVG polyline `points` string for a sparkline over a [0,width]×[0,height]
 * box (y inverted so larger values sit higher). A flat/empty series draws a
 * baseline, never a jump. `pad` insets the stroke so it is not clipped.
 */
export function sparklinePoints(values: number[], width: number, height: number, pad = 1): string {
  if (values.length === 0) return `${pad},${height - pad} ${width - pad},${height - pad}`;
  const max = niceMax(values);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const stepX = values.length === 1 ? 0 : innerW / (values.length - 1);
  return values
    .map((v, i) => {
      const x = pad + (values.length === 1 ? innerW / 2 : i * stepX);
      const y = pad + innerH - (max === 0 ? 0 : (Math.max(0, v) / max) * innerH);
      return `${round(x)},${round(y)}`;
    })
    .join(' ');
}

export interface DonutArc {
  key: string;
  value: number;
  /** stroke-dasharray "<len> <rest>" for a circle of the given circumference. */
  dashArray: string;
  /** stroke-dashoffset positioning this arc after the previous ones. */
  dashOffset: number;
  /** Share of the whole, [0,1] — for the accessible text equivalent. */
  fraction: number;
}

/**
 * Arc geometry for a donut drawn as overlaid stroked circles. Arcs accumulate
 * so they never overlap; a zero total yields no arcs (the caller renders an
 * empty ring). Order is preserved for a stable legend.
 */
export function donutArcs(
  segments: Array<{ key: string; value: number }>,
  circumference: number,
): DonutArc[] {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  if (total === 0) return [];
  let consumed = 0;
  const arcs: DonutArc[] = [];
  for (const seg of segments) {
    const value = Math.max(0, seg.value);
    if (value === 0) continue;
    const fraction = value / total;
    const len = fraction * circumference;
    arcs.push({
      key: seg.key,
      value,
      dashArray: `${round(len)} ${round(circumference - len)}`,
      // Negative offset advances the arc's start past the arcs already drawn.
      dashOffset: -round(consumed),
      fraction,
    });
    consumed += len;
  }
  return arcs;
}

/** A one-line text equivalent of a daily series — the chart's accessible label. */
export function seriesSummary(series: DailySeries): string {
  if (series.series.length === 0) return `No activity in the last ${series.days} days.`;
  const totals = series.keys.map((key) => {
    const sum = series.series.reduce((acc, day) => acc + (day.counts[key] ?? 0), 0);
    return `${sum} ${key}`;
  });
  return `Last ${series.days} days: ${totals.join(', ')}.`;
}

/** Sum a single family across a daily series (the headline number for a spark). */
export function seriesTotal(series: DailySeries, key: string): number {
  return series.series.reduce((acc, day) => acc + (day.counts[key] ?? 0), 0);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
