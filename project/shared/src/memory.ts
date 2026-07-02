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

/** Retrieval score multipliers per status (Addendum §A.5). */
export const STATUS_MULTIPLIERS: Record<MemoryStatus, number> = {
  active: 1.0,
  user_approved: 1.0,
  uncertain: 0.6,
  contradicted: 0.4,
  outdated: 0.2,
  replaced: 0.0,
};
