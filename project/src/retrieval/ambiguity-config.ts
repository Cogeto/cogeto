/**
 * Ambiguity thresholds in ONE versioned place (V2.3 item 6.3, spec §7.5.5).
 * Tuning happens here, backed by the calibration evidence recorded in the
 * pull request that sets each entry — never inline at call sites. Bump the
 * version with any value change so stored decision records stay
 * interpretable.
 *
 * The relevance floor reads the NORMALIZED [0,1] vector similarity the
 * memory module returns (cosine mapped via (s+1)/2), which is embedding-model
 * geometry: 0.75 under one model and 0.75 under another are different
 * claims, the same lesson reconcile-config v2 recorded. The comparability
 * ratio compares fused RRF scores, which are rank-derived and in principle
 * model-independent, but it lives in the same per-model entry so a model
 * whose retrieval composition genuinely differs can carry its own value with
 * evidence instead of arguing about principle.
 */
export const AMBIGUITY_CONFIG_VERSION = 1;

export interface AmbiguityThresholds {
  /**
   * A cluster below this best-member vector similarity does not bear on the
   * question. No cluster above it means the corpus is silent, and a cluster
   * below it never earns a fan-out line. Under mistral-embed the bands are
   * compressed and HIGH: measured over the chat-suite corpora (2026-08-07,
   * live), clusters holding the asked-about attribute scored 0.92 to 0.94
   * and foreign-topic clusters 0.79 to 0.876 (the worst irrelevant draw was
   * a Croatian question against Croatian facts on an unrelated topic). The
   * floor sits in the measured gap; evidence in the V2.3 item 6.3 pull
   * request and docs/features/ambiguity.md.
   */
  relevanceFloor: number;
  /**
   * A cluster whose max member fused score is at least this fraction of the
   * top cluster's is comparable to it: several comparable clusters fan out.
   * What this ratio measures in practice is SIGNAL CONSENSUS: clusters
   * surfaced by the same signals at adjacent ranks sit near 0.97 (always
   * comparable, and rightly so once both cleared the relevance floor), while
   * a cluster the question's entities also matched carries two or three RRF
   * contributions against one and pushes the runner-up to about 0.5 to 0.33
   * (measured 0.49 live). The cut sits above that consensus gap, so the
   * unnamed remainder errs toward fanning out, which is where the
   * silent-guess hazard lives.
   */
  comparabilityRatio: number;
}

/**
 * Calibrated per embedding model. Keys mirror the vector store's dimension
 * registry: exact name first, the base name before any ':tag' suffix second
 * (the Ollama convention).
 */
const CALIBRATED_THRESHOLDS: Record<string, AmbiguityThresholds> = {
  /** Calibrated: the canonical configuration, measured over the chat-suite
   * corpora (relevant versus foreign question similarity bands) in the pull
   * request that shipped V2.3 item 6.3. */
  'mistral-embed': { relevanceFloor: 0.9, comparabilityRatio: 0.55 },
  /**
   * NOT measured. These carry the mistral-embed values so the presets keep
   * working, stated honestly instead of implied calibrated: calibrating them
   * needs a seeded retrieval run with the model configured, and until then
   * the honest claim is "borrowed cut points", not "calibrated".
   */
  'bge-m3': { relevanceFloor: 0.9, comparabilityRatio: 0.55 },
  'text-embedding-3-small': { relevanceFloor: 0.9, comparabilityRatio: 0.55 },
  'text-embedding-3-large': { relevanceFloor: 0.9, comparabilityRatio: 0.55 },
  /** The deterministic fake embedding the test suites run under: mirrors the
   * mistral-embed cut points so the suites exercise the shipped bands. Never
   * a production model. */
  'test-embed': { relevanceFloor: 0.9, comparabilityRatio: 0.55 },
};

/**
 * The thresholds for the ACTIVE embedding model. Throws on an unknown model:
 * silently applying another model's cut points would mis-branch every
 * question, invisibly, forever — the failure reconcile-config v2 exists to
 * remove, repeated here on purpose.
 */
export function ambiguityThresholdsFor(embeddingModel: string): AmbiguityThresholds {
  const base = embeddingModel.split(':')[0]!;
  const thresholds = CALIBRATED_THRESHOLDS[embeddingModel] ?? CALIBRATED_THRESHOLDS[base];
  if (!thresholds) {
    throw new Error(
      `no calibrated ambiguity thresholds for embedding model "${embeddingModel}": ` +
        'add a calibrated entry to CALIBRATED_THRESHOLDS (ambiguity-config.ts) backed by ' +
        'a seeded retrieval run under that model, and bump AMBIGUITY_CONFIG_VERSION',
    );
  }
  return thresholds;
}

/**
 * Fan-out lines shown before the honest "N more subjects matched" line. Four
 * keeps the set scannable as alternatives; the cap is stated, never silent.
 */
export const MAX_FANOUT_LINES = 4;
