import { useSyncExternalStore } from 'react';

/**
 * Theme state (P6.8). Dark is the product default; a light/dark choice persists
 * per browser in localStorage. The pre-paint bootstrap in index.html applies the
 * theme to <html> before React mounts (no flash); this module mirrors that same
 * precedence for the initial resolve and owns the in-app toggle afterwards.
 *
 * Precedence: explicit stored choice ('light'|'dark') > system hint
 * (prefers-color-scheme) > default dark. Once the user toggles, their choice is
 * stored and wins on every subsequent load, on every surface.
 */
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'cogeto-theme';

const listeners = new Set<() => void>();

/**
 * The precedence rule, as a pure function: explicit stored choice > system hint
 * > default dark. Isolated so it is unit-testable without a DOM, and so the
 * index.html bootstrap and this module can never drift on the order.
 */
export function chooseTheme(stored: string | null, systemPrefersLight: boolean): Theme {
  if (stored === 'light' || stored === 'dark') return stored;
  if (systemPrefersLight) return 'light';
  return 'dark';
}

/** The initial theme, resolved the same way as the index.html bootstrap. */
export function resolveInitialTheme(): Theme {
  try {
    return chooseTheme(
      localStorage.getItem(THEME_STORAGE_KEY),
      window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false,
    );
  } catch {
    // Private-mode / disabled storage: fall through to the default.
    return 'dark';
  }
}

/** The theme currently applied to <html> (the bootstrap is the source of truth). */
export function getActiveTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  const marked = document.documentElement.dataset.theme;
  if (marked === 'light' || marked === 'dark') return marked;
  return document.documentElement.classList.contains('dark') ? 'dark' : resolveInitialTheme();
}

/** Apply a theme to <html>; persist the choice unless this is a transient set. */
export function applyTheme(theme: Theme, persist = true): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Non-fatal: the theme still applies for this session.
    }
  }
  listeners.forEach((notify) => notify());
}

export function toggleTheme(): void {
  applyTheme(getActiveTheme() === 'dark' ? 'light' : 'dark');
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** React binding for the current theme plus the toggle/set actions. */
export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
} {
  const theme = useSyncExternalStore(subscribe, getActiveTheme, () => 'dark' as Theme);
  return { theme, toggle: toggleTheme, setTheme: (next) => applyTheme(next) };
}
