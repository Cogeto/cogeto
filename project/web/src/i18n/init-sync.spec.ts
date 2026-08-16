import { describe, expect, it } from 'vitest';
import { initI18n } from './index';

/**
 * The init contract this module documents: SYNCHRONOUS by construction, so
 * the first render already has English in hand and no surface ever paints a
 * raw key. i18next 26 renamed the option that guarantees this
 * (`initImmediate` became `initAsync`) and silently ignores the old name, so
 * an upgrade that misses the rename would defer init and flash raw keys on
 * first paint while every other test still passes. This spec pins the
 * contract itself: no awaiting, no ticks, translated copy in hand on the
 * very next statement.
 */
describe('i18n init is synchronous', () => {
  it('a translated string is available on the statement after initI18n()', () => {
    const i18n = initI18n('en');
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t('common:productName')).toBe('Cogeto');
    expect(i18n.t('common:action.cancel')).toBe('Cancel');
  });
});
