import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAutoResearch, setAutoResearch } from './research-pref';

/** Auto-research preference (decision 0050): off by default, persists per device. */
describe('auto-research preference', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeStore() {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    return store;
  }

  it('defaults to off', () => {
    fakeStore();
    expect(getAutoResearch()).toBe(false);
  });

  it('persists on and off', () => {
    fakeStore();
    setAutoResearch(true);
    expect(getAutoResearch()).toBe(true);
    setAutoResearch(false);
    expect(getAutoResearch()).toBe(false);
  });
});
