import type { TaskList } from 'graphile-worker';
import { idempotentTask, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';

/**
 * The worker's task registry (composition root — modules contribute tasks as
 * their slices ship). `echo` is the §A.3 round-trip demo: its observable effect
 * is one audit row, written in the idempotency transaction, so a duplicate
 * delivery provably changes nothing.
 */
export function buildTaskList(db: Db): TaskList {
  return {
    echo: idempotentTask(db, 'echo', async (tx, payload) => {
      await writeAudit(tx, {
        actor: 'worker:echo',
        action: 'echo',
        entityType: payload.source_type,
        entityId: payload.source_id,
        detail: { message: payload['message'] ?? null },
      });
    }),
  };
}
