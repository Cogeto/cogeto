import { useSyncExternalStore } from 'react';

/**
 * Auto-research preference (decision 0050). When on, a knowledge answer that
 * would offer web research just does it — no tap, no gate, no picking. Off by
 * default; the "Research this on the web" tap is the consent otherwise. Stored
 * per device in localStorage (like the theme), so no migration; toggled from
 * Settings and from a "don't ask again" affordance on the offer.
 */
export const AUTO_RESEARCH_KEY = 'cogeto-auto-research';

const listeners = new Set<() => void>();

export function getAutoResearch(): boolean {
  try {
    return localStorage.getItem(AUTO_RESEARCH_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAutoResearch(on: boolean): void {
  try {
    localStorage.setItem(AUTO_RESEARCH_KEY, on ? '1' : '0');
  } catch {
    // Non-fatal: the preference just won't persist this session.
  }
  listeners.forEach((notify) => notify());
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** React binding for the auto-research preference. */
export function useAutoResearch(): {
  autoResearch: boolean;
  setAutoResearch: (on: boolean) => void;
} {
  const autoResearch = useSyncExternalStore(subscribe, getAutoResearch, () => false);
  return { autoResearch, setAutoResearch };
}
