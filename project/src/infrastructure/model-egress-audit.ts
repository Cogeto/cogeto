import { randomUUID } from 'node:crypto';
import type { Db } from './db';
import { writeAudit } from './audit';
import { currentUsageTaskFamily, currentUsageOrgId, currentUsageUserId } from './usage-context';

/** One model call, as the trail records it. Structural metadata only. */
export interface ModelEgressEntry {
  /** `complete` | `completeStream` | `extractStructured` | `embed`. */
  operation: string;
  /** The tier the call site asked for; call sites never name a model. */
  tier: string;
  /** The provider it routed to, or null when the gateway is unconfigured. */
  provider: string | null;
  /** The resolved model id, or null as above. */
  model: string | null;
  /** Whether the redaction sidecar was in the chain for this instance. */
  redacted: boolean;
  latencyMs: number;
  /** Counts and booleans; never a prompt, a completion, or a fragment of one. */
  detail: Record<string, unknown>;
}

/**
 * The port the model-gateway egress decorator depends on (V2.0 item 3.7). Kept
 * in infrastructure for the same reason {@link ModelUsageMeter} is: the gateway
 * seam may import a leaf, never a domain module, and `audit_log` is
 * infrastructure's table.
 */
export interface ModelEgressAudit {
  recordEgress(entry: ModelEgressEntry): Promise<void>;
}

export const MODEL_EGRESS_AUDIT = Symbol('MODEL_EGRESS_AUDIT');

/**
 * Writes one append-only entry per model call.
 *
 * The attributed user comes from the same usage scope the budget decorator
 * charges (SEC-10), so an entry names who caused the egress wherever there is
 * a causing user: an HTTP request, or a worker job whose payload carried the
 * enqueuing principal. Recurring instance-wide work (the nightly cycle, the
 * sweep) has no causing user and its entries are genuine system entries, which
 * is what a NULL owner means in the contract.
 *
 * `entityId` is a fresh uuid: a model call is an event, not a row, and the
 * integrity sweep's completion entries already use this shape.
 */
export class DbModelEgressAudit implements ModelEgressAudit {
  constructor(private readonly db: Db) {}

  async recordEgress(entry: ModelEgressEntry): Promise<void> {
    const userId = currentUsageUserId();
    await writeAudit(this.db, {
      actor: userId ? `user:${userId}` : 'system',
      action: 'model.egress',
      entityType: 'model_call',
      entityId: randomUUID(),
      detail: {
        operation: entry.operation,
        tier: entry.tier,
        provider: entry.provider,
        model: entry.model,
        redacted: entry.redacted,
        latencyMs: entry.latencyMs,
        taskFamily: currentUsageTaskFamily() ?? null,
        ...entry.detail,
      },
      orgId: currentUsageOrgId(),
      ownerId: userId,
    });
  }
}
