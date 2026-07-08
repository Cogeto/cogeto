import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import type { Tx } from '../infrastructure/index';

/**
 * The action-type contract (§A.8), kept separate from the registry class so an
 * action module and the registry can both depend on it without a cycle.
 */

/**
 * The context an effect executes under. Reconstructed in the worker from the
 * approval row (there is no request principal at execution time) — the effect
 * acts as the user who requested it, scoped to their org.
 */
export interface ActionContext {
  userId: string;
  orgId: string;
}

export interface ActionResult {
  /** Human one-liner recorded on the approval + audit (e.g. "Marked 9, skipped 3"). */
  summary: string;
  detail: Record<string, unknown>;
}

/**
 * One consequential action type. The registry maps action_type → this: a Zod
 * payload schema (validated at every boundary), a human summary/preview
 * renderer for the Pending Approvals surface, an optional create-time
 * authorization check, and the effect handler — which runs ONLY in the worker,
 * inside the execution guard's transaction, so it must express only the effect.
 */
export interface ActionDefinition<P = unknown> {
  actionType: string;
  schema: ZodType<P>;
  /** Where a freshly-created approval starts (most go straight to a decision). */
  initialStatus: 'draft' | 'pending_approval';
  /** How long a pending approval stays actionable before the expiry pass. */
  ttlSeconds: number;
  summarize(payload: P): string;
  preview(payload: P): string[];
  /** Authorize the request (e.g. ownership) at CREATE; throw to refuse. */
  authorizeCreate?(principal: Principal, payload: P): Promise<void>;
  execute(tx: Tx, ctx: ActionContext, payload: P): Promise<ActionResult>;
}
