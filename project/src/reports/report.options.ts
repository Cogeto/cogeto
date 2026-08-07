/** DI token + shape for the reports module's composition-root options. */
export const REPORT_OPTIONS = Symbol('REPORT_OPTIONS');

/**
 * Default retention for a ready report's rendered artifacts (hours). The same
 * 24 hours as the passport export, for the same reason: the artifact is a
 * signed egress of corpus content, the forwarded copy lives outside the
 * instance anyway, and a short window bounds how long the deletion cascade
 * has content-bearing derived artifacts to chase. The RUN ROW is permanent;
 * only the rendered files expire.
 */
export const REPORT_RETENTION_HOURS = 24;

/** The model configuration in force, threaded from the composition root
 * (only entrypoints read the environment). The id is the trust-artifact join
 * key (`deriveProvidersId`); the report states it and looks its published
 * scores up by it. */
export interface ReportModelConfig {
  id: string;
  tiers: {
    pipeline: { provider: string; model: string };
    answer: { provider: string; model: string };
    embedding: { provider: string; model: string };
  };
  vision: { provider: string; model: string } | null;
  redactionEnabled: boolean;
}

export interface ReportOptions {
  /** Where the instance signing keypair lives — the worker signs the payload
   * hash with the private half; the app never needs it. */
  instanceKeyDir: string;
  /** TTL of the presigned download URL (seconds) — mirrors file downloads. */
  downloadUrlTtlSeconds: number;
  /** How long rendered artifacts are retained before the retention pass
   * deletes them (the passport retention decision, applied consistently). */
  exportRetentionHours: number;
  /** Directory holding the vendored report fonts (project/fonts). */
  fontsDir: string;
  /** Directory holding the canonical brand assets (assets/brand). The logo is
   * drawn from the provided file, never a modified copy. */
  brandDir: string;
  /** Directory holding the published trust-score artifacts (eval/trust-scores).
   * Absent or empty is honest: the report then states that no published
   * measurement exists for the configuration. */
  trustScoresDir: string;
  /** The model configuration in force. */
  modelConfig: ReportModelConfig;
}
