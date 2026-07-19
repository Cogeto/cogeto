import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { BULK_OUTDATE_ACTION } from '@cogeto/shared';
import type { MemoryStore } from '../../memory/index';
import type { ActionDefinition } from '../action-types';

/**
 * The one wired consequential action (O1-B §3): mark N of the owner's filtered
 * memories `outdated`. In-system, real, and reversible (outdated → active), so
 * it is fully testable with no external dependency. The effect goes through the
 * Memory aggregate, which owns the eligibility rules (skips `user_approved`,
 * terminal, and already-outdated rows) and audits each transition.
 */
const payloadSchema = z.object({
  memoryIds: z.array(z.uuid()).min(1).max(500),
  reason: z.string().max(500).optional(),
});
type BulkOutdatePayload = z.infer<typeof payloadSchema>;

export function buildBulkOutdateAction(memory: MemoryStore): ActionDefinition<BulkOutdatePayload> {
  return {
    actionType: BULK_OUTDATE_ACTION,
    schema: payloadSchema,
    initialStatus: 'pending_approval',
    ttlSeconds: 24 * 60 * 60, // a day to decide
    summarize: (p) =>
      `Mark ${p.memoryIds.length} memor${p.memoryIds.length === 1 ? 'y' : 'ies'} outdated`,
    preview: (p) => [
      `${p.memoryIds.length} target memor${p.memoryIds.length === 1 ? 'y' : 'ies'}`,
      ...(p.reason ? [`Reason: ${p.reason}`] : []),
      'Excludes user-approved memories; reversible (outdated → active).',
    ],
    // Create-time authorization: the requester must own every target (visible
    // to them, sensitive included). Any id that is not → refuse the whole
    // request, so an approval can never be created over foreign memories.
    authorizeCreate: async (principal, p) => {
      const visible = await memory.getManyForPrincipal(principal, p.memoryIds, {
        includeSensitive: true,
      });
      const owned = new Set(visible.filter((r) => r.ownerId === principal.userId).map((r) => r.id));
      const missing = p.memoryIds.filter((id) => !owned.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          `${missing.length} target memor${missing.length === 1 ? 'y is' : 'ies are'} not yours to change`,
        );
      }
    },
    execute: async (tx, ctx, p) => {
      const { changed, skipped } = await memory.bulkMarkOutdatedForOwner(
        tx,
        ctx.userId,
        p.memoryIds,
        p.reason ?? 'approved bulk action',
      );
      return {
        summary: `Marked ${changed.length} outdated${skipped.length ? `, skipped ${skipped.length}` : ''}`,
        detail: { changed, skipped },
        // QS-27: sync the changed points' Qdrant payload AFTER commit, outside
        // the row-lock window (idempotent; the payload sweep is the backstop).
        afterCommit:
          changed.length > 0 ? () => memory.syncStatusPayloads(changed, 'outdated') : undefined,
      };
    },
  };
}
