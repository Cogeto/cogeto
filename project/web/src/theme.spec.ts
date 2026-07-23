import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, chooseTheme, getActiveTheme, toggleTheme } from './theme';

/**
 * Theme behaviour (P6.8). Three guarantees: dark is the default for a fresh
 * user, the precedence order is honoured, the choice persists and applies, and
 * the theme is set before first paint (no flash). The precedence logic is a pure
 * function; the apply/persist path is exercised against a minimal fake DOM so no
 * jsdom dependency is needed.
 */

// ── theme_default_dark + precedence ─────────────────────────────────────────
describe('chooseTheme precedence: explicit > system hint > default dark', () => {
  it('a fresh user (nothing stored, no system light hint) lands on dark', () => {
    expect(chooseTheme(null, false)).toBe('dark');
  });

  it('defaults to dark even when the system explicitly prefers dark', () => {
    // systemPrefersLight=false covers both "prefers dark" and "no preference".
    expect(chooseTheme(null, false)).toBe('dark');
  });

  it('honours a system light hint only when the user has not chosen', () => {
    expect(chooseTheme(null, true)).toBe('light');
  });

  it('an explicit stored choice wins over the system hint', () => {
    expect(chooseTheme('dark', true)).toBe('dark');
    expect(chooseTheme('light', false)).toBe('light');
  });

  it('ignores a corrupt stored value and falls back to the hint/default', () => {
    expect(chooseTheme('purple', true)).toBe('light');
    expect(chooseTheme('', false)).toBe('dark');
  });
});

// ── apply + persist + toggle ────────────────────────────────────────────────
describe('applyTheme / toggle persist and apply on <html>', () => {
  function fakeDom() {
    const classes = new Set<string>();
    const store = new Map<string, string>();
    const dataset: Record<string, string> = {};
    vi.stubGlobal('document', {
      documentElement: {
        dataset,
        classList: {
          toggle: (c: string, on?: boolean) => (on ? classes.add(c) : classes.delete(c)),
          contains: (c: string) => classes.has(c),
          add: (c: string) => classes.add(c),
        },
      },
    });
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    return { classes, store, dataset };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('applying dark marks <html> and persists the choice', () => {
    const { classes, store, dataset } = fakeDom();
    applyTheme('dark');
    expect(classes.has('dark')).toBe(true);
    expect(dataset.theme).toBe('dark');
    expect(store.get('cogeto-theme')).toBe('dark');
    expect(getActiveTheme()).toBe('dark');
  });

  it('toggling flips the theme, persists it, and reads back the new value', () => {
    const { classes, store } = fakeDom();
    applyTheme('dark');
    toggleTheme();
    expect(classes.has('dark')).toBe(false);
    expect(store.get('cogeto-theme')).toBe('light');
    expect(getActiveTheme()).toBe('light');
    toggleTheme();
    expect(getActiveTheme()).toBe('dark');
    expect(store.get('cogeto-theme')).toBe('dark');
  });
});

// ── no_flash: the theme is applied pre-paint, and CSP-safe ──────────────────
describe('no_flash: an external bootstrap sets the theme before the app script', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const initJs = readFileSync(
    fileURLToPath(new URL('../public/theme-init.js', import.meta.url)),
    'utf8',
  );

  it('references the bootstrap as an EXTERNAL same-origin script (CSP: script-src self)', () => {
    // Inline <script> would be blocked by the strict CSP; it must be src=/theme-init.js.
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(html).not.toMatch(/<script>\s*\(function/);
  });

  it('runs the bootstrap before the module bundle (so paint is never wrong)', () => {
    const bootstrapAt = html.indexOf('/theme-init.js');
    const appAt = html.indexOf('src/main.tsx');
    expect(bootstrapAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeLessThan(appAt);
  });

  it('the bootstrap toggles the dark class from the stored choice', () => {
    expect(initJs).toMatch(/document\.documentElement\.classList\.toggle\(\s*'dark'/);
    expect(initJs).toContain("localStorage.getItem('cogeto-theme')");
  });

  it('falls back to dark, the product default, on any bootstrap error', () => {
    expect(initJs).toMatch(/catch[\s\S]*classList\.add\('dark'\)/);
  });
});
