import type { DbOrTx } from './db';
import { auditLog } from './persistence/tables';

export interface AuditEntry {
  /** e.g. `user:<id>`, `reconciliation`, `verification`, `deletion_saga`, `worker:echo` */
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detail?: Record<string, unknown>;
  /** Zitadel org for org-scoped audit reads (§A.4). NULL = system/global entry. */
  orgId?: string;
}

/**
 * Appends one audit row (append-only — a database trigger rejects UPDATE/DELETE).
 * Pass the surrounding transaction so the audit row commits with the change it records.
 */
export async function writeAudit(executor: DbOrTx, entry: AuditEntry): Promise<void> {
  await executor.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    detailJson: entry.detail ?? null,
    orgId: entry.orgId ?? null,
  });
}
