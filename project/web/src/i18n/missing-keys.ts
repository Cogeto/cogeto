import type { i18n as I18nInstance } from 'i18next';

/**
 * Loud missing keys (V2.0 item 3.5, Issue B point 5).
 *
 * A missing key that quietly falls back to English is exactly the failure this
 * work has to make impossible to hide, so development builds render it as
 * `«namespace:key»` and log every occurrence once.
 *
 * The switch:
 *
 *  - ON by default in a development build (`vite dev`).
 *  - OFF by default in a production build.
 *  - Either default is overridable at runtime, without a rebuild, so the same
 *    check can be run against a real deployment:
 *
 *        localStorage.setItem('cogeto.i18n.debug', 'on')   // force on
 *        localStorage.setItem('cogeto.i18n.debug', 'off')  // force off
 *        localStorage.removeItem('cogeto.i18n.debug')      // back to the default
 *
 * The flag is read once at boot: a change takes effect on the next load, which
 * is what a debugging switch should do (flipping the handler mid-session would
 * leave already-rendered text inconsistent with newly-rendered text).
 */
export const I18N_DEBUG_KEY = 'cogeto.i18n.debug';

export function isI18nDebugEnabled(): boolean {
  let stored: string | null;
  try {
    stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(I18N_DEBUG_KEY);
  } catch {
    // Storage can be blocked (private mode, hardened browsers). Fall through to
    // the build-time default rather than failing to boot.
    stored = null;
  }
  if (stored === 'on') return true;
  if (stored === 'off') return false;
  return import.meta.env.DEV === true;
}

/**
 * Report each missing key once per session. `console.error` (not `warn`) so it
 * survives a filtered console and shows up in an automated browser walk.
 */
export function installMissingKeyReporter(instance: I18nInstance): void {
  const reported = new Set<string>();
  instance.on('missingKey', (locales, namespace, key) => {
    const id = `${String(locales)}|${namespace}|${key}`;
    if (reported.has(id)) return;
    reported.add(id);
    console.error(`[i18n] missing key ${namespace}:${key} for ${String(locales)}`);
  });
}
