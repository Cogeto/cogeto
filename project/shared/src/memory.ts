/**
 * Memory vocabulary (docs/glossary.md; the specification).
 *
 * Six lifecycle statuses plus an orthogonal `sensitive` boolean flag.
 * Statuses are score multipliers in retrieval; `scope` and `sensitive` are hard gates.
 */
export const MEMORY_STATUSES = [
  'active',
  'outdated',
  'contradicted',
  'uncertain',
  'replaced',
  'user_approved',
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SCOPES = ['private', 'shared'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/**
 * Why a fact is not plainly `active` — the sub-reasons that replaced the single
 * undifferentiated `uncertain` bucket (V2.0 item 3.3). Frozen vocabulary: the
 * V2.3 findings report renders these values, so they are added deliberately and
 * never repurposed.
 *
 * Every value is derivable from a signal the pipeline actually produces. There
 * is deliberately NO low-confidence-extraction reason: the extractor emits no
 * confidence field, so the category would have nothing behind it.
 *
 * - `hedged_in_source`     the verifier supported the claim; the SOURCE stated
 *                          it tentatively (extraction's `hedged` flag and its
 *                          verbatim `hedge_phrase`).
 * - `partially_supported`  verifier verdict `partial`.
 * - `unsupported`          verifier verdict `unsupported`.
 * - `unjudgeable`          the verifier could not determine support: its batched
 *                          reply omitted a verdict for this claim, or the cited
 *                          span could not be located in the source, so a
 *                          negative verdict is not attributable to the evidence.
 * - `structurally_invalid` NOT admitted: a blank claim or a blank span. Never
 *                          appears on a memory row, only in the suppressed-fact
 *                          log.
 * - `legacy_unspecified`   backfill only (migration 0039): an `uncertain` row
 *                          predating the taxonomy whose stored verification
 *                          result does not determine a sub-reason. Never written
 *                          by new code, never guessed at.
 */
export const UNCERTAINTY_REASONS = [
  'hedged_in_source',
  'partially_supported',
  'unsupported',
  'unjudgeable',
  'structurally_invalid',
  'legacy_unspecified',
] as const;
export type UncertaintyReason = (typeof UNCERTAINTY_REASONS)[number];

/** Human-readable labels for the sub-reasons — one wording, used everywhere. */
export const UNCERTAINTY_REASON_LABELS: Record<UncertaintyReason, string> = {
  hedged_in_source: 'stated tentatively in the source',
  partially_supported: 'only partly supported by the source',
  unsupported: 'not supported by the cited passage',
  unjudgeable: 'could not be judged against the source',
  structurally_invalid: 'not storable: no claim or no source passage',
  legacy_unspecified: 'recorded before reasons were distinguished',
};

/**
 * The fact kinds the extractor labels (docs/eval-golden-set.md §4 rule 2).
 * Stored on the memory row since migration 0011 — reconciliation's candidate
 * rules match on kind (6). NULL on pre-F2 rows.
 */
export const FACT_KINDS = ['commitment', 'decision', 'preference', 'fact', 'open_loop'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/**
 * How a contradiction finding was resolved: the four owner actions from
 * Review, plus `revision` (V2.3 item 6.1), the automatic resolution recorded
 * when a supersession settled the conflict without a human. Both paths are
 * uniform for reporting: `resolved_at` set, one of these values, the cause in
 * the finding's event log (docs/features/findings.md).
 */
export const RELATION_RESOLUTIONS = [
  'confirmed_a',
  'confirmed_b',
  'corrected',
  'dismissed',
  'revision',
] as const;
export type RelationResolution = (typeof RELATION_RESOLUTIONS)[number];

/** Which pass detected a finding (V2.3 item 6.1): inline at ingestion, the
 * nightly batch, or the post-commit repair window. NULL on pre-0048 rows
 * reads as "not recorded". */
export const RELATION_DETECTORS = ['pipeline', 'dreaming', 'repair'] as const;
export type RelationDetector = (typeof RELATION_DETECTORS)[number];

/** The finding lifecycle's event vocabulary (memory_relation_event, migration
 * 0048). Frozen: the V2.3 report's delta view renders these. */
export const RELATION_EVENTS = [
  'detected',
  'party_superseded',
  'resolved_by_user',
  'resolved_by_revision',
  'kept_open',
  'reopened',
] as const;
export type RelationEvent = (typeof RELATION_EVENTS)[number];

/** One recorded entity-alias pair (V2.3 item 6.1): the Settings surface's
 * row shape over `/api/reconcile-aliases`. */
export interface EntityAliasDto {
  id: string;
  canonical: string;
  alias: string;
  createdAt: string;
}

/** Retrieval score multipliers per status (spec §3.4). */
export const STATUS_MULTIPLIERS: Record<MemoryStatus, number> = {
  active: 1.0,
  user_approved: 1.0,
  uncertain: 0.6,
  contradicted: 0.4,
  outdated: 0.2,
  replaced: 0.0,
};

/**
 * Temporal-mode multipliers: the spec §3.4 temporal lift.
 * Past facts are the point of the query, so replaced/outdated rank nearly on
 * par; statuses stay multipliers, gates stay gates.
 */
export const TEMPORAL_STATUS_MULTIPLIERS: Record<MemoryStatus, number> = {
  active: 1.0,
  user_approved: 1.0,
  uncertain: 0.6,
  contradicted: 0.4,
  outdated: 0.9,
  replaced: 0.9,
};
