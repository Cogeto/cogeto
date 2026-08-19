/**
 * Port for the space-scoped CONTAINERS a space deletion must remove after the
 * ordinary saga has erased every source (docs/features/spaces.md section 5):
 * projects, entity aliases, import runs, research and skill runs, findings
 * reports, passport exports, connectors. The spaces module defines it, each
 * owning module implements it over its own tables, the composition roots bind
 * the array — the DerivedCascade pattern, one module boundary over.
 *
 * None of this is a second deletion mechanism: nothing here touches memories,
 * sources, vectors or receipts. These are the container rows the saga has no
 * reason to know about, and the space row's NO ACTION foreign keys are the
 * backstop: a container an implementation misses refuses the final
 * `DELETE FROM space` loudly instead of surviving as a leftover.
 */
export interface SpaceCleanup {
  /** Names the container class in the plan and the audit detail. */
  readonly artifact: string;
  /** How many rows a deletion WOULD remove — the confirmation surface's
   * honest number. Read-only, cheap, safe to call repeatedly. */
  countForSpace(spaceId: string): Promise<number>;
  /**
   * Removes the space's rows permanently and returns the count plus any
   * object keys whose bytes must be erased with them (report and passport
   * artifacts). Runs in the worker, re-runnable by construction: a second
   * pass finds nothing and removes nothing.
   */
  cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }>;
}

export const SPACE_CLEANUPS = Symbol('SPACE_CLEANUPS');
