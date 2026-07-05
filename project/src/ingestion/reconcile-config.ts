import type { FactKind, MemoryStatus } from '@cogeto/shared';

/**
 * Reconciliation thresholds in ONE versioned place (decision 0010 ruling 6).
 * Tuning happens here, backed by the reconciliation pair-case eval — never
 * inline at call sites. Bump the version with any value change so eval
 * history stays interpretable.
 *
 * All similarities are the NORMALIZED [0,1] scores the memory module's
 * vectorSearch returns (cosine mapped via (s+1)/2 — 0005 ruling 4).
 */
export const RECONCILE_CONFIG_VERSION = 1;

/** Dedup candidate: similarity at/above this is "possibly the same fact". */
export const DEDUP_SIMILARITY = 0.93;

/**
 * Contradiction candidate band: similar topic, different content. The band's
 * top is DEDUP_SIMILARITY — the two candidate pools never overlap on the
 * similarity path.
 */
export const CONTRADICTION_BAND_LOW = 0.8;

/**
 * Dedup's second path: share of the SMALLER entity set that must be covered
 * by case-insensitive exact intersection (plus identical kind, both sets
 * non-empty).
 */
export const ENTITY_OVERLAP_MIN = 0.8;

/** Vector-candidate fetch size per incoming fact. */
export const CANDIDATE_TOP_K = 8;

/** Max model confirmations per prompt family per incoming fact, best first. */
export const MAX_CHECKS_PER_FACT = 3;

/** Existing-memory statuses eligible as dedup candidates (0010 ruling 6). */
export const DEDUP_CANDIDATE_STATUSES: MemoryStatus[] = ['active', 'user_approved', 'uncertain'];

/**
 * Existing-memory statuses eligible as contradiction candidates. Deliberately
 * excludes `uncertain`: unverified noise never earns a warning chip — once
 * approved, the F2-B batch driver revisits it.
 */
export const CONTRADICTION_CANDIDATE_STATUSES: MemoryStatus[] = ['active', 'user_approved'];

/** Kinds that can contradict (0010 ruling 6): open loops are tasks, not claims. */
export const CONTRADICTION_KINDS: FactKind[] = ['fact', 'decision', 'preference', 'commitment'];

/**
 * Dreaming (decision 0011): commitments with no activity for this long are
 * flagged dormant — recorded for the digest and the F3 task engine, never a
 * status transition.
 */
export const DORMANT_SILENCE_DAYS = 14;

/** First-ever dream run looks back this far for its scope window. */
export const DREAM_FIRST_RUN_LOOKBACK_HOURS = 24;

/** Case-insensitive entity-name normalization used by both candidate paths. */
export const normalizeEntity = (name: string): string => name.trim().toLowerCase();

/** |A∩B| / min(|A|,|B|) over normalized names; 0 when either set is empty. */
export function entityOverlap(a: string[], b: string[]): number {
  const setA = new Set(a.map(normalizeEntity));
  const setB = new Set(b.map(normalizeEntity));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const name of setA) if (setB.has(name)) shared += 1;
  return shared / Math.min(setA.size, setB.size);
}
