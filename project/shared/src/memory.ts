/**
 * Memory vocabulary (docs/glossary.md; Addendum §A.6; decision 0003 ruling 3).
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
 * The fact kinds the extractor labels (docs/eval-golden-set.md §4 rule 2).
 * Stored on the memory row since migration 0011 — reconciliation's candidate
 * rules match on kind (decision 0010 rulings 2, 6). NULL on pre-F2 rows.
 */
export const FACT_KINDS = ['commitment', 'decision', 'preference', 'fact', 'open_loop'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** How the owner resolved a contradiction in Review (decision 0010 ruling 3). */
export const RELATION_RESOLUTIONS = [
  'confirmed_a',
  'confirmed_b',
  'corrected',
  'dismissed',
] as const;
export type RelationResolution = (typeof RELATION_RESOLUTIONS)[number];

/** Retrieval score multipliers per status (Addendum §A.5). */
export const STATUS_MULTIPLIERS: Record<MemoryStatus, number> = {
  active: 1.0,
  user_approved: 1.0,
  uncertain: 0.6,
  contradicted: 0.4,
  outdated: 0.2,
  replaced: 0.0,
};

/**
 * Temporal-mode multipliers (decision 0012 ruling 5): the §A.5 temporal lift.
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
