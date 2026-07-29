import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../infrastructure/index';
import { dormantFlag } from './persistence/tables';

/**
 * The dormant-flag consumption API (docs/handoff/F2-dreaming.md §3): ingestion
 * owns the table; every other module reads and clears flags ONLY through
 * these. Dreaming writes flags and clears them when a memory leaves `active`.
 * Since the reader is retrieval's open-loops query, which turns
 * an open flag into the "gone quiet" marker on a standing obligation.
 */

export interface OpenDormantFlag {
  memoryId: string;
  reason: string;
  flaggedAt: Date;
}

export async function listOpenDormantFlags(db: Db): Promise<OpenDormantFlag[]> {
  const rows = await db.select().from(dormantFlag).where(isNull(dormantFlag.clearedAt));
  return rows.map((row) => ({
    memoryId: row.memoryId,
    reason: row.reason,
    flaggedAt: row.flaggedAt,
  }));
}

/** Idempotent: clearing an already-cleared (or absent) flag is a no-op. */
export async function clearDormantFlag(db: Db, memoryId: string): Promise<boolean> {
  const cleared = await db
    .update(dormantFlag)
    .set({ clearedAt: new Date() })
    .where(and(eq(dormantFlag.memoryId, memoryId), isNull(dormantFlag.clearedAt)))
    .returning({ id: dormantFlag.id });
  return cleared.length > 0;
}
