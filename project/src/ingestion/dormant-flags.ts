import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../infrastructure/index';
import { dormantFlag } from './persistence/tables';

/**
 * The dormant-flag consumption API the F2 handoff promised the task engine
 * (docs/handoff/F2-dreaming.md §3; decision 0013 ruling 5): ingestion owns
 * the table; the tasks module reads and clears flags ONLY through these.
 * Dreaming writes flags and clears them when a memory leaves `active`; the
 * task engine clears them when the derived task closes or is dismissed.
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
