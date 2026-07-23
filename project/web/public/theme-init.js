/*
 * Theme bootstrap (P6.8). A same-origin EXTERNAL file, not an inline <script>,
 * so it runs under the strict CSP the SPA is served with (script-src 'self', no
 * 'unsafe-inline' — see project/infra/docker/caddy/Caddyfile). Referenced as a
 * classic, render-blocking <script src> in <head>, so it runs before the deferred
 * module bundle: the theme is set before first paint and there is no flash.
 *
 * Precedence (mirrors resolveInitialTheme in src/theme.ts): explicit stored
 * choice ('light'|'dark') > system hint (prefers-color-scheme) > default dark.
 * Any failure falls back to dark, the product default.
 */
(function () {
  try {
    var stored = localStorage.getItem('cogeto-theme');
    var theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    document.documentElement.classList.add('dark');
    document.documentElement.dataset.theme = 'dark';
  }
})();
