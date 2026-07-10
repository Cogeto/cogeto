import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { writeAudit } from '../infrastructure/index';
import type { Tx } from '../infrastructure/index';
import { approval } from './persistence/tables';
import type { ApprovalRow } from './persistence/tables';
import { ActionRegistry } from './action-registry';

/**
 * The ONLY place a consequential effect runs (§A.8) — the worker, never the
 * app. Invoked from the `approval.execute` job wrapped in the S1-B execution
 * guard (idempotentTask keyed `(approval, <id>, approval.execute)`), so a
 * duplicate delivery claims nothing and the effect runs at most once. Belt and
 * suspenders: it also refuses any row not in `approved`, and treats an already
 * `executed` row as a no-op — a rejected/expired approval can never execute.
 */
@Injectable()
export class ApprovalExecutor {
  constructor(private readonly registry: ActionRegistry) {}

  async execute(tx: Tx, approvalId: string): Promise<{ alreadyExecuted: boolean }> {
    const rows = await tx.select().from(approval).where(eq(approval.id, approvalId)).for('update');
    const row = rows[0] as ApprovalRow | undefined;
    if (!row) throw new Error(`approval ${approvalId} not found`);
    if (row.status === 'executed') return { alreadyExecuted: true };
    if (row.status !== 'approved') {
      throw new Error(`cannot execute approval ${approvalId} in state ${row.status}`);
    }

    const def = this.registry.get(row.actionType);
    const parsed = def.schema.safeParse(row.payloadJson);
    if (!parsed.success) throw new Error(`approval ${approvalId} has an invalid stored payload`);

    const ctx = { userId: row.requestedBy ?? '', orgId: row.orgId ?? '' };
    const result = await def.execute(tx, ctx, parsed.data);

    await tx
      .update(approval)
      .set({ status: 'executed', executedAt: new Date() })
      .where(eq(approval.id, approvalId));
    await writeAudit(tx, {
      actor: `approval_executor:${ctx.userId}`,
      action: 'approval.executed',
      entityType: 'approval',
      entityId: approvalId,
      // summary/detail are counts + ids by the ActionDefinition contract —
      // never memory content (QS-1, decision 0025).
      detail: { actionType: row.actionType, summary: result.summary, ...result.detail },
      orgId: row.orgId ?? undefined,
      ownerId: ctx.userId,
    });
    return { alreadyExecuted: false };
  }
}
