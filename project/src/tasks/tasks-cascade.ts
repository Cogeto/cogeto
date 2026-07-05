import { Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { task } from './persistence/tables';

/**
 * The tasks side of the deletion saga (decision 0013 ruling 6): erasing
 * memories erases their derived tasks, counted for the receipt, inside the
 * enumeration transaction. Implements memory's DerivedCascade port; bound by
 * the composition roots — the saga never touches this table itself.
 */
@Injectable()
export class TasksCascade implements DerivedCascade {
  readonly artifact = 'tasks';

  async cascadeForMemories(tx: Tx, memoryIds: string[]): Promise<number> {
    if (memoryIds.length === 0) return 0;
    const removed = await tx
      .delete(task)
      .where(inArray(task.derivedFromMemoryId, memoryIds))
      .returning({ id: task.id });
    return removed.length;
  }
}
