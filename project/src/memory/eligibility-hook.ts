import type { MemoryRow } from './persistence/tables';

/**
 * The eligibility port (V2.3 item 6.1, issue B): fired when a status change
 * makes a memory eligible for checks it was excluded from — today exactly
 * one case, the owner confirming an `uncertain` fact, which admits it to the
 * contradiction candidate pool. Defined by memory (the owner of the
 * transition), implemented by ingestion (the owner of the repair job), bound
 * at the composition roots — the SourceDeletion pattern, in the other
 * direction (spec §15).
 */
export const MEMORY_ELIGIBILITY_HOOK = Symbol('MEMORY_ELIGIBILITY_HOOK');

export interface MemoryEligibilityHook {
  onEligibilityChanged(row: MemoryRow): Promise<void>;
}
