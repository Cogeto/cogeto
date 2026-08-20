import type { FactKind, MemoryStatus } from '@cogeto/shared';

/**
 * Reconciliation thresholds in ONE versioned place.
 * Tuning happens here, backed by the reconciliation pair-case eval — never
 * inline at call sites. Bump the version with any value change so eval
 * history stays interpretable.
 *
 * All similarities are the NORMALIZED [0,1] scores the memory module's
 * vectorSearch returns (cosine mapped via (s+1)/2 — 0005 ruling 4).
 *
 * v2 (V2.3 item 6.1): thresholds became a FUNCTION of the active embedding
 * model. 0.93 under one model and 0.93 under another are different claims —
 * the local-embedding work shipped without touching these constants, which
 * silently mis-thresholded every non-Mistral configuration. Each supported
 * model now carries its own calibrated values, and an embedding model with no
 * calibration entry fails loudly at the call site instead of borrowing
 * another model's geometry.
 */
export const RECONCILE_CONFIG_VERSION = 2;

export interface ReconcileThresholds {
  /** Dedup candidate: similarity at/above this is "possibly the same fact". */
  dedupSimilarity: number;
  /**
   * Contradiction candidate floor for pairs whose subjects match only by
   * folding: below this the topics are too far apart to spend a check on.
   * Pairs whose subjects match through a recorded ALIAS (cross-language
   * names embed far apart by nature) and pairs that reached the pool through
   * the entity/subject path (no vector score at all) are exempt — there the
   * subject identity itself is the evidence the band was a proxy for.
   */
  contradictionFloor: number;
}

/**
 * Calibrated per embedding model against the golden pair set (the measured
 * bands are recorded in the pull request that sets each entry; the
 * calibration harness is `npm run eval` with the model configured).
 * Keys mirror the vector store's dimension registry: exact name first, the
 * base name before any ':tag' suffix second (the Ollama convention).
 */
const CALIBRATED_THRESHOLDS: Record<string, ReconcileThresholds> = {
  /** Calibrated: the canonical configuration, measured by the golden pair
   * corpus on every gated run. */
  'mistral-embed': { dedupSimilarity: 0.93, contradictionFloor: 0.8 },
  /**
   * NOT measured. These are the values the model ran under before v2 (the
   * constants applied to every model alike), kept so the presets keep
   * working, stated honestly instead of implied calibrated. Only English and
   * Croatian extraction quality is gated at all, and only mistral-embed has a
   * measured similarity distribution; calibrating these three needs a golden
   * pair run with the model configured, and until then the honest claim is
   * "unchanged from v1 behaviour", not "calibrated".
   */
  'bge-m3': { dedupSimilarity: 0.93, contradictionFloor: 0.8 },
  'text-embedding-3-small': { dedupSimilarity: 0.93, contradictionFloor: 0.8 },
  'text-embedding-3-large': { dedupSimilarity: 0.93, contradictionFloor: 0.8 },
  /** The deterministic fake embedding the test suites run under: mirrors the
   * mistral-embed cut points so the suites exercise the same bands the
   * canonical configuration ships with. Never a production model. */
  'test-embed': { dedupSimilarity: 0.93, contradictionFloor: 0.8 },
};

/**
 * The thresholds for the ACTIVE embedding model. Throws on an unknown model:
 * silently applying another model's cut points is the failure mode v2 exists
 * to remove (a wrong threshold is invisible — it just merges too much or
 * flags too little, forever).
 */
export function reconcileThresholdsFor(
  embeddingModel: string,
  // The geometry identity is the lookup key (`gateway.embeddingGeometryId()`);
  // the display name is what the message may carry, so an upstream identifier
  // behind a served name never leaves through a log line.
  displayName: string = embeddingModel,
): ReconcileThresholds {
  const base = embeddingModel.split(':')[0]!;
  const thresholds = CALIBRATED_THRESHOLDS[embeddingModel] ?? CALIBRATED_THRESHOLDS[base];
  if (!thresholds) {
    throw new Error(
      `no calibrated reconciliation thresholds for embedding model "${displayName}": ` +
        'add a calibrated entry to CALIBRATED_THRESHOLDS (reconcile-config.ts) backed by ' +
        'a golden pair-set run under that model, and bump RECONCILE_CONFIG_VERSION',
    );
  }
  return thresholds;
}

/**
 * Dedup's second path: share of the SMALLER entity set that must be covered
 * by canonical-key intersection (plus identical kind, both sets non-empty).
 * A ratio over canonical keys, not raw similarity — model-independent.
 */
export const ENTITY_OVERLAP_MIN = 0.8;

/** Vector-candidate fetch size per incoming fact. */
export const CANDIDATE_TOP_K = 8;

/** Max model confirmations per prompt family per incoming fact, best first.
 * Ledger hits (already-judged pairs) never consume this budget. */
export const MAX_CHECKS_PER_FACT = 3;

/** Existing-memory statuses eligible as dedup candidates (0010 ruling 6). */
export const DEDUP_CANDIDATE_STATUSES: MemoryStatus[] = ['active', 'user_approved', 'uncertain'];

/**
 * Existing-memory statuses eligible as contradiction candidates. Deliberately
 * excludes `uncertain`: unverified noise never earns a warning chip — the
 * eligibility re-pair hook revisits a fact the moment the user confirms it,
 * and the batch driver covers the rest. Includes `contradicted` since 6.1:
 * a party to an open finding must be supersedable by a revision's corrected
 * fact, or a corrected corpus can never resolve its own findings.
 */
export const CONTRADICTION_CANDIDATE_STATUSES: MemoryStatus[] = [
  'active',
  'user_approved',
  'contradicted',
];

/** Kinds that can contradict (0010 ruling 6): an open loop is an obligation,
 * not a claim about the world, so it never contradicts one. */
export const CONTRADICTION_KINDS: FactKind[] = ['fact', 'decision', 'preference', 'commitment'];

/**
 * How far back the post-commit repair pass re-pairs (V2.3 item 6.1, issue B):
 * facts admitted by OTHER jobs inside this window are the near-simultaneous
 * uploads the inline pass structurally cannot see (their rows were uncommitted
 * during stage 6). The repair job runs this many minutes after admission.
 */
export const REPAIR_DELAY_MINUTES = 3;

/**
 * Dreaming: commitments with no activity for this long are
 * flagged dormant — recorded for the digest and the open-loops read, never a
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
