import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';

/**
 * Tables owned by the agents module (migration 0001,; support columns
 * in migration 0015). Module-private. The approval state machine goes live in
 *; the schema has been contractual from day one (0003 ruling 1).
 */

export const approvalStatusEnum = pgEnum('approval_status', [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'executed',
]);

export const approval = pgTable(
  'approval',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The space whose content the action is over (docs/features/spaces.md,
     * migration 0061): the approvals queue is a space-scoped sidebar surface,
     * so a pending approval is counted and listed only in its own space. */
    spaceId: uuid('space_id').notNull().default(DEFAULT_SPACE_ID),
    actionType: text('action_type').notNull(),
    payloadJson: jsonb('payload_json'),
    status: approvalStatusEnum('status').notNull().default('draft'),
    /** Zitadel org of the requester — the confirm authorization gate (0015). */
    orgId: text('org_id'),
    requestedBy: text('requested_by'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('approval_status_idx').on(t.status),
    index('approval_org_status_idx').on(t.orgId, t.status),
  ],
);

export type ApprovalRow = typeof approval.$inferSelect;
