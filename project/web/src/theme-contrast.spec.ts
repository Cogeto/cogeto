import { describe, expect, it } from 'vitest';

/**
 * Dark-theme contrast, verified programmatically (P6.8). Pure WCAG 2.1 math over
 * the actual dark token values from index.css: no dependency, no browser. We
 * assert AA (>= 4.5:1) for every load-bearing TEXT token against its real dark
 * background, and >= 3:1 (WCAG 1.4.11 non-text) for chart hues on the surface.
 *
 * The status/tone chips render as an accent tint (accent at 15% alpha) composited
 * over the surface, with the accent's light -300 shade as ink; we composite that
 * exactly. Accent reference sRGB are the Tailwind palette values (index.css does
 * not remap the accent ramps). Measured ratios are recorded in
 * docs/notes/surface-polish.md.
 */

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(hexToRgb(a));
  const lb = relativeLuminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Source-over composite of `fg` at `alpha` on opaque `bg`, returning a hex. */
function tint(fg: string, alpha: number, bg: string): string {
  const [fr, fg_, fb] = hexToRgb(fg);
  const [br, bg_, bb] = hexToRgb(bg);
  const mix = (f: number, b: number) => Math.round(alpha * f + (1 - alpha) * b);
  const to2 = (n: number) => n.toString(16).padStart(2, '0');
  return `#${to2(mix(fr, br))}${to2(mix(fg_, bg_))}${to2(mix(fb, bb))}`;
}

// The dark palette — mirrors :root.dark in index.css.
const CANVAS = '#0f1222'; // --color-slate-50 (app background)
const SURFACE = '#171a2e'; // --color-surface (cards/headers/drawers)

const NEUTRAL_TEXT = {
  'slate-400 (muted)': '#8b94b4',
  'slate-500 (secondary)': '#a4adc9',
  'slate-600': '#bcc4dd',
  'slate-700': '#d3d9ec',
  'slate-800 (primary)': '#e6eaf6',
};

const CHART = {
  active: '#2dd4bf',
  approved: '#5eead4',
  uncertain: '#fbbf24',
  contradicted: '#f87171',
  outdated: '#94a3b8',
  replaced: '#cbd5e1',
};

// Accent references (Tailwind palette — not remapped in dark). Chip bg = accent
// at 15% over the surface; chip ink = the accent's -300 shade.
const BRAND_TEAL = '#21c29a';
const CHIPS: Record<string, { accent: string; ink: string }> = {
  'active/approved/positive (teal)': { accent: BRAND_TEAL, ink: BRAND_TEAL },
  'uncertain/warning (amber)': { accent: '#fbbf24', ink: '#fcd34d' },
  'contradicted/danger (red)': { accent: '#ef4444', ink: '#fca5a5' },
  'sensitive/info (violet)': { accent: '#a78bfa', ink: '#c4b5fd' },
  'shared (sky)': { accent: '#38bdf8', ink: '#7dd3fc' },
};

describe('dark theme: neutral text tokens are AA on canvas and surface', () => {
  for (const [name, hex] of Object.entries(NEUTRAL_TEXT)) {
    it(`${name} >= 4.5:1 on canvas and surface`, () => {
      expect(contrast(hex, CANVAS)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex, SURFACE)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('dark theme: status/tone chips keep AA ink over their tinted background', () => {
  for (const [name, { accent, ink }] of Object.entries(CHIPS)) {
    it(`${name}: ink is AA on the 15% tint`, () => {
      const bg = tint(accent, 0.15, SURFACE);
      expect(contrast(ink, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('dark theme: chart hues are >= 3:1 (non-text) on the surface', () => {
  for (const [name, hex] of Object.entries(CHART)) {
    it(`chart ${name} >= 3:1 on surface`, () => {
      expect(contrast(hex, SURFACE)).toBeGreaterThanOrEqual(3);
    });
  }
});
