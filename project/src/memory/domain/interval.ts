import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { memory } from '../persistence/tables';

/**
 * THE interval predicate (decision 0012 ruling 1) — the one place the
 * [effective_from, valid_until) convention is encoded. Half-open: a fact
 * holds AT valid_from and does NOT hold at valid_until; NULL valid_from falls
 * back to created_at ("since ingestion"); NULL valid_until means "still
 * holding". Every temporal query uses one of these two forms; no caller
 * hand-rolls the predicate.
 */

/** A fact holds at t iff effective_from <= t AND (until IS NULL OR t < until). */
export function intervalHoldsAt(
  row: { validFrom: Date | null; validUntil: Date | null; createdAt: Date },
  t: Date,
): boolean {
  const effectiveFrom = row.validFrom ?? row.createdAt;
  if (t.getTime() < effectiveFrom.getTime()) return false;
  return row.validUntil === null || t.getTime() < row.validUntil.getTime();
}

/** The SQL twin, over the memory table's columns. Kept in lockstep with the
 * pure form by the interval_predicate_matrix truth-table test. */
export function intervalHoldsAtSql(t: Date): SQL {
  return sql`(
    COALESCE(${memory.validFrom}, ${memory.createdAt}) <= ${t}
    AND (${memory.validUntil} IS NULL OR ${t} < ${memory.validUntil})
  )`;
}

/**
 * Past belief (decision 0012 ruling 6): the fact is no longer presented as
 * current — replaced/outdated, or its interval closed before now.
 */
export function isPastBelief(
  row: { status: string; validFrom: Date | null; validUntil: Date | null; createdAt: Date },
  now: Date = new Date(),
): boolean {
  if (row.status === 'replaced' || row.status === 'outdated') return true;
  return row.validUntil !== null && row.validUntil.getTime() <= now.getTime();
}
