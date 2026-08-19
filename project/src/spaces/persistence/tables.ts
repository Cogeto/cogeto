import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Tables owned by the `spaces` module (migration 0060). Module-private.
 *
 * A space is a fully sealed partition of the instance
 * (docs/features/spaces.md): everything content-bearing lives inside exactly
 * one space, and no feature ever operates across two. The rows here are the
 * partition RECORDS only; the wall itself is the `space_id` gate dimension
 * carried by every content-bearing root and enforced inside the memory
 * module's queries and the vector payload pre-filter.
 */

export const space = pgTable('space', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The user's last used space, resolved on login and falling back to the
 * default space. A pointer, never membership: every instance user sees every
 * space, by owner decision (docs/features/spaces.md section 7).
 */
export const userSpaceState = pgTable('user_space_state', {
  userId: text('user_id').primaryKey(),
  lastSpaceId: uuid('last_space_id')
    .notNull()
    .references(() => space.id, { onDelete: 'cascade' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SpaceRow = typeof space.$inferSelect;
export type UserSpaceStateRow = typeof userSpaceState.$inferSelect;
