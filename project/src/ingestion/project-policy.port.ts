/**
 * The per-project extraction policy port (V2.5 item 8.3 issue C4).
 *
 * `ingestion` defines it because the pipeline is the enforcement point, and
 * `projects` implements it because a project is what carries the numbers: the
 * established port direction (`SOURCE_READERS`, `INGESTION_GUARD`,
 * `MEMORY_ELIGIBILITY_HOOK`), bound at the composition roots.
 *
 * What it deliberately is NOT: a new dimension of the extraction gate. The
 * gate's decision model is untouched. This returns at most three numbers that
 * fold into the SAME tightest-wins arithmetic every other bound already uses
 * (parse cap, source-type registry budget, gate row, gate rule, project), plus
 * one flag that refuses through the existing refusal ledger with its own named
 * reason. A project with nothing configured returns null and the pipeline runs
 * byte-identically to a pipeline that never heard of projects.
 */
export interface ProjectExtractionPolicy {
  /** false = store the source, extract nothing. null/absent = no opinion. */
  enabled: boolean | null;
  factBudget: number | null;
  retentionDays: number | null;
}

export interface ProjectPolicyPort {
  /**
   * The policy of the project a source belongs to, or null when the source is
   * in no project (which is most sources, and the pre-feature path).
   */
  policyForSource(sourceType: string, sourceId: string): Promise<ProjectExtractionPolicy | null>;
}

export const PROJECT_POLICY = Symbol('PROJECT_POLICY');
